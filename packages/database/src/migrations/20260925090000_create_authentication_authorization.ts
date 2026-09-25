import { sql, type Kysely } from "kysely";

/** Creates Phase 4 credentials, server sessions, scoped roles, audit records, and verified ledger actors. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    -- Login identities are managed outside migrations. These NOLOGIN roles are
    -- capability groups: the runtime login is granted platform_runtime and the
    -- separately held provisioning login is granted platform_provisioner.
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'platform_runtime') then
        create role platform_runtime nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'platform_provisioner') then
        create role platform_provisioner nologin noinherit;
      end if;
    end $$;

    create extension if not exists pgcrypto;
    alter table platform.users add column password_login_locked_until timestamptz;
    alter table platform.users add column password_login_failed_count integer not null default 0 check (password_login_failed_count >= 0);
    alter table platform.users add column password_login_window_started_at timestamptz;

    create table platform.password_credentials (
      user_id uuid primary key references platform.users(id) on delete restrict,
      password_hash text not null check (password_hash like '$argon2id$%'),
      credential_version integer not null check (credential_version > 0),
      must_change boolean not null default false,
      changed_at timestamptz not null default current_timestamp,
      created_at timestamptz not null default current_timestamp,
      updated_at timestamptz not null default current_timestamp
    );
    create table platform.password_credential_history (
      id uuid primary key default uuidv7(),
      user_id uuid not null references platform.users(id) on delete restrict,
      credential_version integer not null check (credential_version > 0),
      password_hash text not null check (password_hash like '$argon2id$%'),
      retired_at timestamptz not null default current_timestamp,
      created_at timestamptz not null default current_timestamp,
      unique (user_id, credential_version)
    );
    create table platform.auth_sessions (
      id uuid primary key default uuidv7(),
      user_id uuid not null references platform.users(id) on delete restrict,
      secret_digest bytea not null unique check (octet_length(secret_digest) = 32),
      credential_version integer not null check (credential_version > 0),
      issued_at timestamptz not null default current_timestamp,
      idle_expires_at timestamptz not null,
      absolute_expires_at timestamptz not null,
      revoked_at timestamptz,
      revocation_reason varchar(63),
      created_at timestamptz not null default current_timestamp,
      updated_at timestamptz not null default current_timestamp,
      check (idle_expires_at >= issued_at and absolute_expires_at >= idle_expires_at),
      check ((revoked_at is null and revocation_reason is null) or (revoked_at is not null and length(btrim(revocation_reason)) > 0))
    );
    create index auth_sessions_active_user_idx on platform.auth_sessions (user_id, idle_expires_at) where revoked_at is null;
    create table platform.password_reset_tokens (
      id uuid primary key default uuidv7(),
      user_id uuid not null references platform.users(id) on delete restrict,
      token_digest bytea not null unique check (octet_length(token_digest) = 32),
      issued_by_user_id uuid not null references platform.users(id) on delete restrict,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default current_timestamp,
      check (expires_at > created_at),
      check (not (consumed_at is not null and revoked_at is not null))
    );
    create unique index password_reset_tokens_one_active_idx on platform.password_reset_tokens (user_id) where consumed_at is null and revoked_at is null;

    create table platform.account_role_assignments (
      id uuid primary key default uuidv7(),
      user_id uuid not null references platform.users(id) on delete restrict,
      account_id uuid references platform.accounts(id) on delete restrict,
      role varchar(32) not null check (role in ('USER', 'ADMIN', 'TRADING_OPERATOR', 'RISK_OPERATOR', 'AUDITOR', 'SUPER_ADMIN')),
      enabled boolean not null default true,
      revoked_at timestamptz,
      revoked_by_user_id uuid references platform.users(id) on delete restrict,
      revocation_reason text,
      created_at timestamptz not null default current_timestamp,
      updated_at timestamptz not null default current_timestamp,
      check ((role = 'SUPER_ADMIN' and account_id is null) or (role <> 'SUPER_ADMIN' and account_id is not null)),
      check ((enabled and revoked_at is null and revoked_by_user_id is null and revocation_reason is null) or (not enabled and revoked_at is not null and revoked_by_user_id is not null and length(btrim(coalesce(revocation_reason, ''))) > 0))
    );
    create unique index account_role_assignments_one_active_idx on platform.account_role_assignments (user_id, account_id, role) where enabled;
    create table platform.auth_bootstrap_state (
      id boolean primary key default true check (id),
      completed_at timestamptz,
      first_super_admin_user_id uuid references platform.users(id) on delete restrict,
      created_at timestamptz not null default current_timestamp,
      updated_at timestamptz not null default current_timestamp,
      check ((completed_at is null and first_super_admin_user_id is null) or (completed_at is not null and first_super_admin_user_id is not null))
    );
    insert into platform.auth_bootstrap_state (id) values (true);
    create table platform.audit_events (
      id uuid primary key default uuidv7(),
      event_type varchar(63) not null,
      outcome varchar(32) not null check (outcome in ('success', 'failure', 'system')),
      actor_user_id uuid references platform.users(id) on delete restrict,
      subject_user_id uuid references platform.users(id) on delete restrict,
      account_id uuid references platform.accounts(id) on delete restrict,
      session_id uuid references platform.auth_sessions(id) on delete restrict,
      correlation_id uuid,
      metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
      occurred_at timestamptz not null default current_timestamp,
      created_at timestamptz not null default current_timestamp
    );

    alter table platform.ledger_transactions add column actor_user_id uuid references platform.users(id) on delete restrict;
    alter table platform.ledger_transactions add column actor_session_id uuid references platform.auth_sessions(id) on delete restrict;

    create function platform.reject_auth_history_mutation()
    returns trigger language plpgsql as $$ begin raise exception 'Authentication history is immutable.' using errcode = '55000'; end; $$;
    create trigger password_credential_history_reject_mutation before update or delete on platform.password_credential_history for each row execute function platform.reject_auth_history_mutation();
    create function platform.prevent_password_reset_token_mutation()
    returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' or new.user_id is distinct from old.user_id or new.token_digest is distinct from old.token_digest or new.issued_by_user_id is distinct from old.issued_by_user_id or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at then
        raise exception 'Password reset token content is immutable.' using errcode = '55000';
      end if;
      if old.consumed_at is not null or old.revoked_at is not null then raise exception 'Password reset token state is immutable.' using errcode = '55000'; end if;
      if new.consumed_at is null and new.revoked_at is null then raise exception 'Password reset token must be consumed or revoked.' using errcode = '55000'; end if;
      return new;
    end; $$;
    create trigger password_reset_tokens_prevent_mutation before update or delete on platform.password_reset_tokens for each row execute function platform.prevent_password_reset_token_mutation();
    create trigger audit_events_reject_mutation before update or delete on platform.audit_events for each row execute function platform.reject_auth_history_mutation();
    create trigger account_role_assignments_reject_delete before delete on platform.account_role_assignments for each row execute function platform.reject_auth_history_mutation();
    create trigger auth_bootstrap_state_reject_delete before delete on platform.auth_bootstrap_state for each row execute function platform.reject_auth_history_mutation();
    create trigger ledger_transactions_actor_immutable before update of actor_user_id, actor_session_id, actor_reference on platform.ledger_transactions for each row execute function platform.reject_ledger_mutation();
    create function platform.require_verified_ledger_actor()
    returns trigger language plpgsql as $$
    begin
      if new.actor_user_id is null or new.actor_session_id is null or new.actor_reference <> 'user:' || new.actor_user_id::text then
        raise exception 'Ledger transaction requires a verified actor.' using errcode = '42501';
      end if;
      return new;
    end; $$;
    create trigger ledger_transactions_require_verified_actor before insert on platform.ledger_transactions for each row execute function platform.require_verified_ledger_actor();

    create function platform.set_auth_updated_at()
    returns trigger language plpgsql as $$ begin new.updated_at := current_timestamp; return new; end; $$;
    create trigger password_credentials_set_updated_at before update on platform.password_credentials for each row execute function platform.set_auth_updated_at();
    create trigger auth_sessions_set_updated_at before update on platform.auth_sessions for each row execute function platform.set_auth_updated_at();
    create trigger account_role_assignments_set_updated_at before update on platform.account_role_assignments for each row execute function platform.set_auth_updated_at();
    create trigger auth_bootstrap_state_set_updated_at before update on platform.auth_bootstrap_state for each row execute function platform.set_auth_updated_at();

    create function platform.append_audit_event(p_event_type text, p_outcome text, p_actor uuid, p_subject uuid, p_account uuid, p_session uuid, p_correlation uuid, p_metadata jsonb)
    returns uuid language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_id uuid;
    begin
      if p_event_type is null or length(btrim(p_event_type)) = 0 or p_outcome not in ('success', 'failure', 'system') or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
        raise exception 'Invalid audit event.' using errcode = '22023';
      end if;
      insert into platform.audit_events (event_type, outcome, actor_user_id, subject_user_id, account_id, session_id, correlation_id, metadata)
      values (p_event_type, p_outcome, p_actor, p_subject, p_account, p_session, p_correlation, p_metadata) returning id into v_id;
      return v_id;
    end; $$;

    create function platform.require_authenticated_session(p_session_id uuid, p_session_secret text, p_required_permission text, p_account_id uuid default null)
    returns table(user_id uuid, session_id uuid) language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_user uuid; v_version integer; v_role_ok boolean;
    begin
      if p_session_id is null or p_session_secret is null or length(p_session_secret) < 32 then raise exception 'Authentication is required.' using errcode = '28000'; end if;
      select s.user_id, s.credential_version into v_user, v_version
      from platform.auth_sessions s join platform.users u on u.id = s.user_id join platform.password_credentials c on c.user_id = u.id
      where s.id = p_session_id and s.secret_digest = public.digest(convert_to(p_session_secret, 'UTF8'), 'sha256') and s.revoked_at is null
        and s.idle_expires_at > current_timestamp and s.absolute_expires_at > current_timestamp
        and u.enabled and c.credential_version = s.credential_version
      for update of s;
      if not found then raise exception 'Authentication is required.' using errcode = '28000'; end if;
      if p_required_permission like 'ledger.post.%' or p_required_permission = 'password.reset.issue' then
        select exists(select 1 from platform.account_role_assignments r where r.user_id = v_user and r.role = 'SUPER_ADMIN' and r.enabled) into v_role_ok;
      else
        select exists(select 1 from platform.account_role_assignments r where r.user_id = v_user and r.account_id = p_account_id and r.enabled) into v_role_ok;
      end if;
      if not v_role_ok then raise exception 'Authorization is required.' using errcode = '42501'; end if;
      update platform.auth_sessions set idle_expires_at = least(absolute_expires_at, current_timestamp + interval '30 minutes') where id = p_session_id;
      return query select v_user, p_session_id;
    end; $$;

    create function platform.create_auth_session(p_user_id uuid, p_secret text, p_credential_version integer, p_idle_expires_at timestamptz, p_absolute_expires_at timestamptz)
    returns uuid language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_id uuid;
    begin
      if p_secret is null or length(p_secret) < 32 then raise exception 'Invalid session secret.' using errcode = '22023'; end if;
      insert into platform.auth_sessions (user_id, secret_digest, credential_version, idle_expires_at, absolute_expires_at)
      values (p_user_id, public.digest(convert_to(p_secret, 'UTF8'), 'sha256'), p_credential_version, p_idle_expires_at, p_absolute_expires_at) returning id into v_id;
      perform platform.append_audit_event('session_created', 'success', p_user_id, p_user_id, null, v_id, null, '{}'::jsonb);
      return v_id;
    end; $$;

    create function platform.record_failed_password_login(p_user_code text)
    returns void language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_count integer; v_user uuid; v_lock timestamptz;
    begin
      select id, password_login_failed_count into v_user, v_count from platform.users where user_code = p_user_code for update;
      if not found then return; end if;
      if (select password_login_window_started_at from platform.users where id = v_user) is null or (select password_login_window_started_at from platform.users where id = v_user) < current_timestamp - interval '24 hours' then v_count := 0; end if;
      v_count := v_count + 1;
      v_lock := case when v_count >= 6 then current_timestamp + interval '1 hour' when v_count = 5 then current_timestamp + interval '15 minutes' when v_count = 4 then current_timestamp + interval '2 minutes' when v_count = 3 then current_timestamp + interval '30 seconds' else null end;
      update platform.users set password_login_failed_count = v_count, password_login_window_started_at = current_timestamp, password_login_locked_until = v_lock where id = v_user;
      perform platform.append_audit_event('login_failed', 'failure', null, v_user, null, null, null, '{}'::jsonb);
    end; $$;

    create function platform.record_successful_password_login(p_user_id uuid)
    returns void language plpgsql security definer set search_path = pg_catalog, platform as $$
    begin
      update platform.users
      set password_login_failed_count = 0, password_login_window_started_at = null, password_login_locked_until = null
      where id = p_user_id;
    end; $$;

    create function platform.revoke_auth_session(p_session_id uuid, p_reason text)
    returns void language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_user uuid;
    begin
      update platform.auth_sessions set revoked_at = current_timestamp, revocation_reason = p_reason where id = p_session_id and revoked_at is null returning user_id into v_user;
      if found then perform platform.append_audit_event('session_revoked', 'success', v_user, v_user, null, p_session_id, null, jsonb_build_object('reason', p_reason)); end if;
    end; $$;

    create function platform.issue_password_reset(p_session_id uuid, p_session_secret text, p_target_user_code text, p_token_secret text)
    returns uuid language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_actor uuid; v_target uuid; v_token uuid;
    begin
      select user_id into v_actor from platform.require_authenticated_session(p_session_id, p_session_secret, 'password.reset.issue');
      if not exists(select 1 from platform.account_role_assignments where user_id = v_actor and role = 'SUPER_ADMIN' and enabled) then raise exception 'Authorization is required.' using errcode = '42501'; end if;
      select id into v_target from platform.users where user_code = p_target_user_code and enabled for update;
      if not found or p_token_secret is null or length(p_token_secret) < 32 then raise exception 'Reset issuance is unavailable.' using errcode = '22023'; end if;
      update platform.password_reset_tokens set revoked_at = current_timestamp where user_id = v_target and consumed_at is null and revoked_at is null;
      insert into platform.password_reset_tokens (user_id, token_digest, issued_by_user_id, expires_at)
      values (v_target, public.digest(convert_to(p_token_secret, 'UTF8'), 'sha256'), v_actor, current_timestamp + interval '15 minutes') returning id into v_token;
      perform platform.append_audit_event('password_reset_issued', 'success', v_actor, v_target, null, p_session_id, null, '{}'::jsonb);
      return v_token;
    end; $$;

    create function platform.bootstrap_first_super_admin(p_user_code text, p_password_hash text)
    returns uuid language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_user uuid;
    begin
      perform pg_advisory_xact_lock(hashtext('platform.auth.bootstrap'));
      perform 1 from platform.auth_bootstrap_state where id for update;
      if (select completed_at is not null from platform.auth_bootstrap_state where id) or exists(select 1 from platform.account_role_assignments where role = 'SUPER_ADMIN' and enabled) then raise exception 'Authentication bootstrap is already complete.' using errcode = '55000'; end if;
      if p_user_code !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or p_password_hash not like '$argon2id$%' then raise exception 'Invalid bootstrap input.' using errcode = '22023'; end if;
      insert into platform.users (user_code, enabled) values (p_user_code, true) returning id into v_user;
      insert into platform.password_credentials (user_id, password_hash, credential_version) values (v_user, p_password_hash, 1);
      insert into platform.account_role_assignments (user_id, account_id, role, enabled) values (v_user, null, 'SUPER_ADMIN', true);
      update platform.auth_bootstrap_state set completed_at = current_timestamp, first_super_admin_user_id = v_user where id;
      perform platform.append_audit_event('super_admin_bootstrapped', 'system', null, v_user, null, null, null, '{}'::jsonb);
      return v_user;
    end; $$;

    drop function platform.post_ledger_transaction(text, uuid, uuid, numeric, text, text, text, text, jsonb, timestamptz);
    create function platform.post_ledger_transaction(
      p_session_id uuid, p_session_secret text, p_event_type text, p_wallet_id uuid, p_asset_id uuid, p_amount numeric,
      p_customer_entry_side text, p_idempotency_key text, p_reason text, p_metadata jsonb, p_occurred_at timestamptz
    ) returns uuid language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_existing platform.ledger_transactions%rowtype; v_wallet_asset_id uuid; v_wallet_account_id uuid; v_customer_ledger_account_id uuid; v_counterparty_ledger_account_id uuid; v_counterparty_code text; v_balance numeric; v_transaction_id uuid; v_actor_user_id uuid; v_actor_session_id uuid;
    begin
      if p_event_type not in ('deposit', 'withdrawal', 'manual_adjustment') or p_customer_entry_side not in ('debit', 'credit') or p_amount is null or p_amount <= 0 or p_amount = 'NaN'::numeric or p_amount <> trunc(p_amount, 18) or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 200 or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or p_occurred_at is null then raise exception 'Invalid ledger posting request.' using errcode = '22023'; end if;
      if (p_event_type = 'deposit' and p_customer_entry_side <> 'credit') or (p_event_type = 'withdrawal' and p_customer_entry_side <> 'debit') or (p_event_type = 'manual_adjustment' and length(btrim(coalesce(p_reason, ''))) = 0) or (p_event_type <> 'manual_adjustment' and p_reason is not null) then raise exception 'Ledger posting event semantics are invalid.' using errcode = '22023'; end if;
      select wallet.asset_id, wallet.account_id into v_wallet_asset_id, v_wallet_account_id from platform.wallets wallet join platform.assets asset on asset.id = wallet.asset_id where wallet.id = p_wallet_id and wallet.enabled and asset.enabled for update of wallet, asset;
      if not found or v_wallet_asset_id <> p_asset_id then raise exception 'Wallet and asset are not eligible for ledger posting.' using errcode = '23514'; end if;
      select user_id, session_id into v_actor_user_id, v_actor_session_id from platform.require_authenticated_session(p_session_id, p_session_secret, 'ledger.post.' || p_event_type, v_wallet_account_id);
      select * into v_existing from platform.ledger_transactions where idempotency_key = p_idempotency_key for update;
      if found then
        if v_existing.event_type = p_event_type and v_existing.wallet_id = p_wallet_id and v_existing.asset_id = p_asset_id and v_existing.amount = p_amount and v_existing.customer_entry_side = p_customer_entry_side and v_existing.actor_user_id = v_actor_user_id and v_existing.reason is not distinct from p_reason and v_existing.metadata = p_metadata and v_existing.occurred_at = p_occurred_at then return v_existing.id; end if;
        raise exception 'Idempotency key conflicts with a different ledger request.' using errcode = '23505';
      end if;
      select id into v_customer_ledger_account_id from platform.ledger_accounts where wallet_id = p_wallet_id and account_code = 'customer_wallet' and enabled;
      if not found then raise exception 'Customer ledger account is unavailable.' using errcode = '23514'; end if;
      v_counterparty_code := case p_event_type when 'deposit' then 'external_deposit_clearing' when 'withdrawal' then 'external_withdrawal_clearing' else 'manual_adjustment_clearing' end;
      select id into v_counterparty_ledger_account_id from platform.ledger_accounts where asset_id = p_asset_id and account_code = v_counterparty_code and enabled;
      if not found then raise exception 'Platform clearing ledger account is unavailable.' using errcode = '23514'; end if;
      perform id from platform.ledger_accounts where id in (v_customer_ledger_account_id, v_counterparty_ledger_account_id) order by id for update;
      if p_customer_entry_side = 'debit' then select coalesce(sum(case entry_side when 'credit' then amount else -amount end), 0) into v_balance from platform.ledger_entries where ledger_account_id = v_customer_ledger_account_id; if v_balance < p_amount then raise exception 'Ledger posting would overdraw the wallet.' using errcode = '23514'; end if; end if;
      perform set_config('platform.ledger_posting', 'on', true);
      begin
        insert into platform.ledger_transactions (event_type, asset_id, wallet_id, customer_ledger_account_id, counterparty_ledger_account_id, customer_entry_side, amount, idempotency_key, actor_reference, actor_user_id, actor_session_id, reason, metadata, occurred_at)
        values (p_event_type, p_asset_id, p_wallet_id, v_customer_ledger_account_id, v_counterparty_ledger_account_id, p_customer_entry_side, p_amount, p_idempotency_key, 'user:' || v_actor_user_id::text, v_actor_user_id, v_actor_session_id, p_reason, p_metadata, p_occurred_at) returning id into v_transaction_id;
      exception when unique_violation then
        select * into v_existing from platform.ledger_transactions where idempotency_key = p_idempotency_key for update;
        if found and v_existing.event_type = p_event_type and v_existing.wallet_id = p_wallet_id and v_existing.asset_id = p_asset_id and v_existing.amount = p_amount and v_existing.customer_entry_side = p_customer_entry_side and v_existing.actor_user_id = v_actor_user_id and v_existing.reason is not distinct from p_reason and v_existing.metadata = p_metadata and v_existing.occurred_at = p_occurred_at then return v_existing.id; end if;
        raise exception 'Idempotency key conflicts with a different ledger request.' using errcode = '23505';
      end;
      insert into platform.ledger_entries (ledger_transaction_id, ledger_account_id, entry_side, amount) values (v_transaction_id, v_customer_ledger_account_id, p_customer_entry_side, p_amount), (v_transaction_id, v_counterparty_ledger_account_id, case p_customer_entry_side when 'credit' then 'debit' else 'credit' end, p_amount);
      return v_transaction_id;
    end; $$;

    -- SECURITY DEFINER functions are capability boundaries. PUBLIC must never
    -- receive an implicit execution path around the application roles.
    revoke all on function platform.append_audit_event(text, text, uuid, uuid, uuid, uuid, uuid, jsonb) from public;
    revoke all on function platform.require_authenticated_session(uuid, text, text, uuid) from public;
    revoke all on function platform.create_auth_session(uuid, text, integer, timestamptz, timestamptz) from public;
    revoke all on function platform.record_failed_password_login(text) from public;
    revoke all on function platform.record_successful_password_login(uuid) from public;
    revoke all on function platform.revoke_auth_session(uuid, text) from public;
    revoke all on function platform.issue_password_reset(uuid, text, text, text) from public;
    revoke all on function platform.bootstrap_first_super_admin(text, text) from public;
    revoke all on platform.ledger_transactions, platform.ledger_entries from public;
    revoke all on function platform.post_ledger_transaction(uuid, text, text, uuid, uuid, numeric, text, text, text, jsonb, timestamptz) from public;

    grant usage on schema platform to platform_runtime, platform_provisioner;
    grant select (id, user_code, enabled, password_login_locked_until) on platform.users to platform_runtime;
    grant select (user_id, password_hash, credential_version) on platform.password_credentials to platform_runtime;
    grant execute on function platform.require_authenticated_session(uuid, text, text, uuid) to platform_runtime;
    grant execute on function platform.create_auth_session(uuid, text, integer, timestamptz, timestamptz) to platform_runtime;
    grant execute on function platform.record_failed_password_login(text) to platform_runtime;
    grant execute on function platform.record_successful_password_login(uuid) to platform_runtime;
    grant execute on function platform.revoke_auth_session(uuid, text) to platform_runtime;
    grant execute on function platform.issue_password_reset(uuid, text, text, text) to platform_runtime;
    grant execute on function platform.post_ledger_transaction(uuid, text, text, uuid, uuid, numeric, text, text, text, jsonb, timestamptz) to platform_runtime;
    grant execute on function platform.bootstrap_first_super_admin(text, text) to platform_provisioner;
  `).execute(database);
}
