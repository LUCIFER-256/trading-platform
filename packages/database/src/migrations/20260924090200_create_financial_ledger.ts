import { sql, type Kysely } from "kysely";

/** Creates the immutable, asset-denominated financial ledger and its posting boundary. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .withSchema("platform")
    .createTable("ledger_accounts")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("asset_id", "uuid", (column) => column.notNull())
    .addColumn("account_id", "uuid")
    .addColumn("wallet_id", "uuid")
    .addColumn("account_code", "varchar(63)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("ledger_accounts_pkey", ["id"])
    .addUniqueConstraint("ledger_accounts_wallet_id_key", ["wallet_id"])
    .addCheckConstraint(
      "ledger_accounts_shape_check",
      sql`(
        account_code = 'customer_wallet' and account_id is not null and wallet_id is not null
      ) or (
        account_code in ('external_deposit_clearing', 'external_withdrawal_clearing', 'manual_adjustment_clearing')
        and account_id is null and wallet_id is null
      )`
    )
    .addForeignKeyConstraint("ledger_accounts_asset_id_fkey", ["asset_id"], "platform.assets", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint("ledger_accounts_account_id_fkey", ["account_id"], "platform.accounts", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint("ledger_accounts_wallet_id_fkey", ["wallet_id"], "platform.wallets", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("ledger_transactions")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("event_type", "varchar(32)", (column) => column.notNull())
    .addColumn("asset_id", "uuid", (column) => column.notNull())
    .addColumn("wallet_id", "uuid", (column) => column.notNull())
    .addColumn("customer_ledger_account_id", "uuid", (column) => column.notNull())
    .addColumn("counterparty_ledger_account_id", "uuid", (column) => column.notNull())
    .addColumn("customer_entry_side", "varchar(6)", (column) => column.notNull())
    .addColumn("amount", sql`numeric(38,18)`, (column) => column.notNull())
    .addColumn("idempotency_key", sql`text collate "C"`, (column) => column.notNull())
    .addColumn("actor_reference", sql`text collate "C"`, (column) => column.notNull())
    .addColumn("reason", "text")
    .addColumn("metadata", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("ledger_transactions_pkey", ["id"])
    .addUniqueConstraint("ledger_transactions_idempotency_key_key", ["idempotency_key"])
    .addCheckConstraint("ledger_transactions_event_type_check", sql`event_type in ('deposit', 'withdrawal', 'manual_adjustment')`)
    .addCheckConstraint("ledger_transactions_entry_side_check", sql`customer_entry_side in ('debit', 'credit')`)
    .addCheckConstraint("ledger_transactions_amount_check", sql`amount > 0 and amount <> 'NaN'::numeric`)
    .addCheckConstraint("ledger_transactions_idempotency_key_check", sql`length(idempotency_key) between 1 and 200`)
    .addCheckConstraint("ledger_transactions_actor_reference_check", sql`length(btrim(actor_reference)) between 1 and 200`)
    .addCheckConstraint("ledger_transactions_metadata_object_check", sql`jsonb_typeof(metadata) = 'object'`)
    .addCheckConstraint(
      "ledger_transactions_reason_check",
      sql`(event_type = 'manual_adjustment' and length(btrim(coalesce(reason, ''))) > 0) or (event_type <> 'manual_adjustment' and reason is null)`
    )
    .addForeignKeyConstraint("ledger_transactions_asset_id_fkey", ["asset_id"], "platform.assets", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint("ledger_transactions_wallet_id_fkey", ["wallet_id"], "platform.wallets", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint(
      "ledger_transactions_customer_ledger_account_id_fkey",
      ["customer_ledger_account_id"],
      "platform.ledger_accounts",
      ["id"],
      (constraint) => constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint(
      "ledger_transactions_counterparty_ledger_account_id_fkey",
      ["counterparty_ledger_account_id"],
      "platform.ledger_accounts",
      ["id"],
      (constraint) => constraint.onDelete("restrict")
    )
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("ledger_entries")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("ledger_transaction_id", "uuid", (column) => column.notNull())
    .addColumn("ledger_account_id", "uuid", (column) => column.notNull())
    .addColumn("entry_side", "varchar(6)", (column) => column.notNull())
    .addColumn("amount", sql`numeric(38,18)`, (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("ledger_entries_pkey", ["id"])
    .addUniqueConstraint("ledger_entries_transaction_id_account_id_key", ["ledger_transaction_id", "ledger_account_id"])
    .addCheckConstraint("ledger_entries_entry_side_check", sql`entry_side in ('debit', 'credit')`)
    .addCheckConstraint("ledger_entries_amount_check", sql`amount > 0 and amount <> 'NaN'::numeric`)
    .addForeignKeyConstraint("ledger_entries_transaction_id_fkey", ["ledger_transaction_id"], "platform.ledger_transactions", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint("ledger_entries_ledger_account_id_fkey", ["ledger_account_id"], "platform.ledger_accounts", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  await sql.raw(`
    create unique index ledger_accounts_system_asset_code_key
    on platform.ledger_accounts (asset_id, account_code)
    where account_code <> 'customer_wallet'
  `).execute(database);
  await database.schema.withSchema("platform").createIndex("ledger_entries_account_created_at_idx").on("ledger_entries").columns(["ledger_account_id", "created_at"]).execute();
  await database.schema.withSchema("platform").createIndex("ledger_transactions_wallet_created_at_idx").on("ledger_transactions").columns(["wallet_id", "created_at"]).execute();

  await sql.raw(`
    create function platform.ensure_asset_clearing_accounts(p_asset_id uuid, p_enabled boolean)
    returns void
    language plpgsql
    as $$
    begin
      if p_enabled then
        insert into platform.ledger_accounts (asset_id, account_code, enabled)
        values
          (p_asset_id, 'external_deposit_clearing', true),
          (p_asset_id, 'external_withdrawal_clearing', true),
          (p_asset_id, 'manual_adjustment_clearing', true)
        on conflict (asset_id, account_code) where account_code <> 'customer_wallet'
        do update set enabled = excluded.enabled;
      else
        update platform.ledger_accounts
        set enabled = false
        where asset_id = p_asset_id
          and account_code in ('external_deposit_clearing', 'external_withdrawal_clearing', 'manual_adjustment_clearing');
      end if;
    end;
    $$;

    create function platform.ensure_asset_clearing_accounts_trigger()
    returns trigger
    language plpgsql
    as $$
    begin
      perform platform.ensure_asset_clearing_accounts(new.id, new.enabled);
      return new;
    end;
    $$;

    create trigger assets_ensure_clearing_accounts
    after insert or update of enabled on platform.assets
    for each row execute function platform.ensure_asset_clearing_accounts_trigger();

    create function platform.ensure_wallet_ledger_account()
    returns trigger
    language plpgsql
    as $$
    begin
      insert into platform.ledger_accounts (asset_id, account_id, wallet_id, account_code, enabled)
      values (new.asset_id, new.account_id, new.id, 'customer_wallet', new.enabled)
      on conflict (wallet_id) do update set enabled = excluded.enabled;
      return new;
    end;
    $$;

    create trigger wallets_ensure_ledger_account
    after insert or update of enabled on platform.wallets
    for each row execute function platform.ensure_wallet_ledger_account();

    create function platform.prevent_wallet_identity_change()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.account_id is distinct from old.account_id or new.asset_id is distinct from old.asset_id then
        raise exception 'Wallet account and asset are immutable.' using errcode = '23514';
      end if;
      return new;
    end;
    $$;

    create trigger wallets_prevent_identity_change
    before update on platform.wallets
    for each row execute function platform.prevent_wallet_identity_change();

    select platform.ensure_asset_clearing_accounts(id, enabled) from platform.assets;

    create function platform.reject_direct_ledger_insert()
    returns trigger
    language plpgsql
    as $$
    begin
      if current_setting('platform.ledger_posting', true) is distinct from 'on' then
        raise exception 'Ledger writes must use the platform posting function.' using errcode = '42501';
      end if;
      return new;
    end;
    $$;

    create trigger ledger_transactions_reject_direct_insert
    before insert on platform.ledger_transactions
    for each row execute function platform.reject_direct_ledger_insert();

    create trigger ledger_entries_reject_direct_insert
    before insert on platform.ledger_entries
    for each row execute function platform.reject_direct_ledger_insert();

    create function platform.reject_ledger_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception 'Ledger records are immutable.' using errcode = '55000';
    end;
    $$;

    create trigger ledger_transactions_reject_mutation
    before update or delete on platform.ledger_transactions
    for each row execute function platform.reject_ledger_mutation();

    create trigger ledger_entries_reject_mutation
    before update or delete on platform.ledger_entries
    for each row execute function platform.reject_ledger_mutation();

    create function platform.assert_ledger_transaction_balanced(p_transaction_id uuid)
    returns void
    language plpgsql
    as $$
    declare
      v_asset_id uuid;
      v_entry_count integer;
      v_total numeric;
      v_assets_match boolean;
    begin
      select asset_id into v_asset_id from platform.ledger_transactions where id = p_transaction_id;
      if not found then
        raise exception 'Ledger transaction does not exist.' using errcode = '23503';
      end if;

      select
        count(*),
        coalesce(sum(case entry.entry_side when 'credit' then entry.amount else -entry.amount end), 0),
        coalesce(bool_and(ledger_account.asset_id = v_asset_id), false)
      into v_entry_count, v_total, v_assets_match
      from platform.ledger_entries as entry
      join platform.ledger_accounts as ledger_account on ledger_account.id = entry.ledger_account_id
      where entry.ledger_transaction_id = p_transaction_id;

      if v_entry_count < 2 or v_total <> 0 or not v_assets_match then
        raise exception 'Ledger transaction must have balanced entries for its asset.' using errcode = '23514';
      end if;
    end;
    $$;

    create function platform.assert_ledger_transaction_header_trigger()
    returns trigger
    language plpgsql
    as $$
    begin
      perform platform.assert_ledger_transaction_balanced(new.id);
      return new;
    end;
    $$;

    create function platform.assert_ledger_entry_trigger()
    returns trigger
    language plpgsql
    as $$
    begin
      perform platform.assert_ledger_transaction_balanced(new.ledger_transaction_id);
      return new;
    end;
    $$;

    create constraint trigger ledger_transactions_balanced
    after insert on platform.ledger_transactions
    deferrable initially deferred
    for each row execute function platform.assert_ledger_transaction_header_trigger();

    create constraint trigger ledger_entries_balanced
    after insert on platform.ledger_entries
    deferrable initially deferred
    for each row execute function platform.assert_ledger_entry_trigger();

    create function platform.post_ledger_transaction(
      p_event_type text,
      p_wallet_id uuid,
      p_asset_id uuid,
      p_amount numeric,
      p_customer_entry_side text,
      p_idempotency_key text,
      p_actor_reference text,
      p_reason text,
      p_metadata jsonb,
      p_occurred_at timestamptz
    )
    returns uuid
    language plpgsql
    as $$
    declare
      v_existing platform.ledger_transactions%rowtype;
      v_wallet_asset_id uuid;
      v_customer_ledger_account_id uuid;
      v_counterparty_ledger_account_id uuid;
      v_counterparty_code text;
      v_balance numeric;
      v_transaction_id uuid;
    begin
      if p_event_type not in ('deposit', 'withdrawal', 'manual_adjustment')
        or p_customer_entry_side not in ('debit', 'credit')
        or p_amount is null
        or p_amount <= 0
        or p_amount = 'NaN'::numeric
        or p_amount <> trunc(p_amount, 18)
        or p_idempotency_key is null
        or length(p_idempotency_key) not between 1 and 200
        or p_actor_reference is null
        or length(btrim(p_actor_reference)) not between 1 and 200
        or p_metadata is null
        or jsonb_typeof(p_metadata) <> 'object'
        or p_occurred_at is null then
        raise exception 'Invalid ledger posting request.' using errcode = '22023';
      end if;
      if (p_event_type = 'deposit' and p_customer_entry_side <> 'credit')
        or (p_event_type = 'withdrawal' and p_customer_entry_side <> 'debit')
        or (p_event_type = 'manual_adjustment' and length(btrim(coalesce(p_reason, ''))) = 0)
        or (p_event_type <> 'manual_adjustment' and p_reason is not null) then
        raise exception 'Ledger posting event semantics are invalid.' using errcode = '22023';
      end if;

      select * into v_existing
      from platform.ledger_transactions
      where idempotency_key = p_idempotency_key
      for update;
      if found then
        if v_existing.event_type = p_event_type
          and v_existing.wallet_id = p_wallet_id
          and v_existing.asset_id = p_asset_id
          and v_existing.amount = p_amount
          and v_existing.customer_entry_side = p_customer_entry_side
          and v_existing.actor_reference = p_actor_reference
          and v_existing.reason is not distinct from p_reason
          and v_existing.metadata = p_metadata
          and v_existing.occurred_at = p_occurred_at then
          return v_existing.id;
        end if;
        raise exception 'Idempotency key conflicts with a different ledger request.' using errcode = '23505';
      end if;

      select wallet.asset_id into v_wallet_asset_id
      from platform.wallets as wallet
      join platform.assets as asset on asset.id = wallet.asset_id
      where wallet.id = p_wallet_id and wallet.enabled and asset.enabled
      for update of wallet, asset;
      if not found or v_wallet_asset_id <> p_asset_id then
        raise exception 'Wallet and asset are not eligible for ledger posting.' using errcode = '23514';
      end if;

      select id into v_customer_ledger_account_id
      from platform.ledger_accounts
      where wallet_id = p_wallet_id and account_code = 'customer_wallet' and enabled;
      if not found then
        raise exception 'Customer ledger account is unavailable.' using errcode = '23514';
      end if;

      v_counterparty_code := case p_event_type
        when 'deposit' then 'external_deposit_clearing'
        when 'withdrawal' then 'external_withdrawal_clearing'
        else 'manual_adjustment_clearing'
      end;
      select id into v_counterparty_ledger_account_id
      from platform.ledger_accounts
      where asset_id = p_asset_id and account_code = v_counterparty_code and enabled;
      if not found then
        raise exception 'Platform clearing ledger account is unavailable.' using errcode = '23514';
      end if;

      perform id
      from platform.ledger_accounts
      where id in (v_customer_ledger_account_id, v_counterparty_ledger_account_id)
      order by id
      for update;

      if p_customer_entry_side = 'debit' then
        select coalesce(sum(case entry_side when 'credit' then amount else -amount end), 0)
        into v_balance
        from platform.ledger_entries
        where ledger_account_id = v_customer_ledger_account_id;
        if v_balance < p_amount then
          raise exception 'Ledger posting would overdraw the wallet.' using errcode = '23514';
        end if;
      end if;

      perform set_config('platform.ledger_posting', 'on', true);
      begin
        insert into platform.ledger_transactions (
          event_type, asset_id, wallet_id, customer_ledger_account_id, counterparty_ledger_account_id,
          customer_entry_side, amount, idempotency_key, actor_reference, reason, metadata, occurred_at
        )
        values (
          p_event_type, p_asset_id, p_wallet_id, v_customer_ledger_account_id, v_counterparty_ledger_account_id,
          p_customer_entry_side, p_amount, p_idempotency_key, p_actor_reference, p_reason, p_metadata, p_occurred_at
        )
        returning id into v_transaction_id;
      exception when unique_violation then
        select * into v_existing
        from platform.ledger_transactions
        where idempotency_key = p_idempotency_key
        for update;
        if found
          and v_existing.event_type = p_event_type
          and v_existing.wallet_id = p_wallet_id
          and v_existing.asset_id = p_asset_id
          and v_existing.amount = p_amount
          and v_existing.customer_entry_side = p_customer_entry_side
          and v_existing.actor_reference = p_actor_reference
          and v_existing.reason is not distinct from p_reason
          and v_existing.metadata = p_metadata
          and v_existing.occurred_at = p_occurred_at then
          return v_existing.id;
        end if;
        raise exception 'Idempotency key conflicts with a different ledger request.' using errcode = '23505';
      end;

      insert into platform.ledger_entries (ledger_transaction_id, ledger_account_id, entry_side, amount)
      values
        (v_transaction_id, v_customer_ledger_account_id, p_customer_entry_side, p_amount),
        (v_transaction_id, v_counterparty_ledger_account_id, case p_customer_entry_side when 'credit' then 'debit' else 'credit' end, p_amount);

      return v_transaction_id;
    end;
    $$;

    create view platform.wallet_balances as
    select
      wallet.id as wallet_id,
      wallet.account_id,
      wallet.asset_id,
      coalesce(sum(case entry.entry_side when 'credit' then entry.amount else -entry.amount end), 0)::numeric(38,18) as balance,
      coalesce(sum(case entry.entry_side when 'credit' then entry.amount else -entry.amount end), 0)::numeric(38,18) as available_balance,
      0::numeric(38,18) as reserved_funds
    from platform.wallets as wallet
    join platform.ledger_accounts as ledger_account on ledger_account.wallet_id = wallet.id and ledger_account.account_code = 'customer_wallet'
    left join platform.ledger_entries as entry on entry.ledger_account_id = ledger_account.id
    group by wallet.id, wallet.account_id, wallet.asset_id;
  `).execute(database);

  await sql.raw(`
    create trigger ledger_accounts_set_updated_at
    before update on platform.ledger_accounts
    for each row execute function platform.set_catalog_updated_at()
  `).execute(database);
}
