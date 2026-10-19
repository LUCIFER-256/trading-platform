import { sql, type Kysely } from "kysely";

/** Creates the approved Sprint 5.1 market-data persistence boundary. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'platform_owner') then create role platform_owner nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'platform_market_data') then create role platform_market_data nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'platform_market_data_operator') then create role platform_market_data_operator nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'platform_catalog_provisioner') then create role platform_catalog_provisioner nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'platform_market_data_consumer') then create role platform_market_data_consumer nologin noinherit; end if;
    end $$;

    alter table platform.providers add column enabled boolean not null default false;
    alter table platform.instruments add column price_increment numeric(38,18);
    alter table platform.instruments add column size_increment numeric(38,18);
    alter table platform.instruments add constraint instruments_price_increment_positive check (price_increment is null or price_increment > 0);
    alter table platform.instruments add constraint instruments_size_increment_positive check (size_increment is null or size_increment > 0);

    create table platform.market_data_policies (
      instrument_id uuid primary key references platform.instruments(id) on delete restrict,
      enabled boolean not null default false,
      max_ingestion_age_ms integer not null default 10000 check (max_ingestion_age_ms between 100 and 600000),
      max_event_age_ms integer not null default 10000 check (max_event_age_ms between 100 and 3600000),
      max_future_skew_ms integer not null default 2000 check (max_future_skew_ms between 0 and 60000),
      max_initial_event_delay_ms integer not null default 5000 check (max_initial_event_delay_ms between 100 and 3600000),
      max_price_jump_bps integer not null default 2000 check (max_price_jump_bps between 1 and 1000000),
      heartbeat_timeout_ms integer not null default 5000 check (heartbeat_timeout_ms between 1000 and 600000),
      circuit_failure_threshold integer not null default 5 check (circuit_failure_threshold between 1 and 100),
      circuit_failure_window_ms integer not null default 60000 check (circuit_failure_window_ms between 1000 and 3600000),
      circuit_cooldown_ms integer not null default 30000 check (circuit_cooldown_ms between 1000 and 3600000),
      circuit_half_open_ready_ms integer not null default 10000 check (circuit_half_open_ready_ms between 1000 and 3600000),
      heartbeat_ahead_count integer not null default 4 check (heartbeat_ahead_count between 4 and 100),
      heartbeat_ahead_span_ms integer not null default 2500 check (heartbeat_ahead_span_ms between 2500 and 3600000),
      heartbeat_settle_count integer not null default 4 check (heartbeat_settle_count between 3 and 100),
      heartbeat_settle_span_ms integer not null default 3000 check (heartbeat_settle_span_ms between 2500 and 3600000),
      jump_reset_tolerance_bps integer not null default 100 check (jump_reset_tolerance_bps between 1 and 1000000),
      jump_reset_ttl_ms integer not null default 300000 check (jump_reset_ttl_ms between 1000 and 3600000),
      created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
    );
    create table platform.market_data_observations (
      id uuid primary key default uuidv7(), provider_id uuid not null references platform.providers(id) on delete restrict,
      instrument_id uuid not null references platform.instruments(id) on delete restrict, provider_symbol text collate "C" not null,
      provider_sequence numeric(20,0) not null check (provider_sequence >= 0), trade_id numeric(20,0) not null check (trade_id >= 0),
      event_at_us numeric(20,0) not null check (event_at_us between 0 and 253402300799999999), event_at timestamptz not null, received_at timestamptz not null,
      ingested_at timestamptz not null default clock_timestamp(), bid_as_of_last_trade numeric(38,18) not null check (bid_as_of_last_trade > 0),
      bid_size_as_of_last_trade numeric(38,18) not null check (bid_size_as_of_last_trade > 0), ask_as_of_last_trade numeric(38,18) not null check (ask_as_of_last_trade > 0),
      ask_size_as_of_last_trade numeric(38,18) not null check (ask_size_as_of_last_trade > 0), last_trade_price numeric(38,18) not null check (last_trade_price > 0),
      last_trade_size numeric(38,18) not null check (last_trade_size > 0), volume_24h numeric(38,18) check (volume_24h is null or volume_24h >= 0),
      unique (provider_id, instrument_id, trade_id), check (event_at = timestamptz 'epoch' + div(event_at_us,1000000)::bigint * interval '1 second' + mod(event_at_us,1000000)::bigint * interval '1 microsecond')
    );
    create table platform.market_data_instrument_state (
      instrument_id uuid primary key references platform.instruments(id) on delete restrict, provider_id uuid not null references platform.providers(id) on delete restrict,
      observation_id uuid references platform.market_data_observations(id) on delete restrict,
      base_availability text not null check (base_availability in ('AVAILABLE','UNAVAILABLE_DISABLED_SCOPE','UNAVAILABLE_REBASELINING','UNAVAILABLE_PROVIDER_CIRCUIT','UNAVAILABLE_PERSISTENCE','UNAVAILABLE_HUMAN_HALT')),
      event_at timestamptz, ingested_at timestamptz, provider_sequence numeric(20,0), trade_id numeric(20,0), bid_as_of_last_trade numeric(38,18),
      bid_size_as_of_last_trade numeric(38,18), ask_as_of_last_trade numeric(38,18), ask_size_as_of_last_trade numeric(38,18), last_trade_price numeric(38,18),
      last_trade_size numeric(38,18), volume_24h numeric(38,18), last_accepted_price numeric(38,18) check (last_accepted_price is null or last_accepted_price > 0),
      updated_at timestamptz not null default clock_timestamp(), check ((base_availability = 'AVAILABLE' and observation_id is not null and event_at is not null and ingested_at is not null and last_accepted_price is not null) or base_availability <> 'AVAILABLE')
    );
    create table platform.market_data_quality_events (
      id uuid primary key default uuidv7(), provider_id uuid not null references platform.providers(id) on delete restrict,
      instrument_id uuid references platform.instruments(id) on delete restrict, decision text not null check (decision in ('REJECT','QUARANTINE','HALT','RECOVERY')),
      requires_human_clear boolean not null, reason_code text not null check (reason_code in ('MALFORMED','NONFINITE','NONPOSITIVE','OFF_GRID','FUTURE_TIME','EXCESSIVE_EVENT_DELAY','EVENT_TIME_REGRESSION','DUPLICATE','OUT_OF_ORDER_MATCH_ID','IN_SESSION_MATCH_GAP','HEARTBEAT_GAP','HEARTBEAT_TIMEOUT','LOCKED_OR_CROSSED','PRICE_JUMP','QUEUE_OVERFLOW','PERSISTENCE_TIMEOUT','PRODUCT_ASSERTION_FAILURE','DISABLED_OR_UNMAPPED','PROVIDER_CIRCUIT','IDEMPOTENCY_CONFLICT')),
      trade_id numeric(20,0), provider_sequence numeric(20,0), event_at timestamptz, candidate_price numeric(38,18), candidate_size numeric(38,18),
      ingested_at timestamptz not null default clock_timestamp(), check ((decision in ('HALT','QUARANTINE') and requires_human_clear) or (decision in ('REJECT','RECOVERY') and not requires_human_clear))
    );
    create table platform.market_data_halts (
      id uuid primary key default uuidv7(), quality_event_id uuid not null unique references platform.market_data_quality_events(id) on delete restrict,
      instrument_id uuid not null references platform.instruments(id) on delete restrict, reason_code text not null check (reason_code in ('LOCKED_OR_CROSSED','OUT_OF_ORDER_MATCH_ID','IN_SESSION_MATCH_GAP','PRICE_JUMP','PRODUCT_ASSERTION_FAILURE','IDEMPOTENCY_CONFLICT')),
      candidate_price numeric(38,18), candidate_size numeric(38,18), candidate_trade_id numeric(20,0), candidate_provider_sequence numeric(20,0), reference_price numeric(38,18),
      opened_at timestamptz not null default clock_timestamp(), check ((reason_code = 'PRICE_JUMP' and candidate_price is not null and candidate_price > 0 and reference_price is not null and reference_price > 0) or (reason_code <> 'PRICE_JUMP' and candidate_price is null and reference_price is null))
    );
    create table platform.market_data_halt_resolutions (
      id uuid primary key default uuidv7(), halt_id uuid not null unique references platform.market_data_halts(id) on delete restrict,
      actor_user_id uuid not null references platform.users(id) on delete restrict, actor_session_id uuid not null references platform.auth_sessions(id) on delete restrict,
      resolution_reason text not null check (length(btrim(resolution_reason)) between 1 and 500), confirmed_candidate_price numeric(38,18), resolved_at timestamptz not null default clock_timestamp()
    );
    create table platform.market_data_jump_resets (
      id uuid primary key default uuidv7(), instrument_id uuid not null references platform.instruments(id) on delete restrict,
      resolution_id uuid not null unique references platform.market_data_halt_resolutions(id) on delete restrict, confirmed_candidate_price numeric(38,18) not null check (confirmed_candidate_price > 0),
      tolerance_bps integer not null check (tolerance_bps between 1 and 1000000), expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp()
    );
    create table platform.market_data_jump_reset_consumptions (
      id uuid primary key default uuidv7(), reset_id uuid not null unique references platform.market_data_jump_resets(id) on delete restrict,
      observation_id uuid not null unique references platform.market_data_observations(id) on delete restrict, consumed_at timestamptz not null default clock_timestamp()
    );
    create table platform.market_data_quality_buckets (
      id uuid primary key default uuidv7(), provider_id uuid not null references platform.providers(id) on delete restrict,
      instrument_id uuid references platform.instruments(id) on delete restrict, reason_code text not null, bucket_started_at timestamptz not null,
      rejected_count bigint not null check (rejected_count > 0), created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
    );
    create table platform.market_data_quality_bucket_flushes (flush_id uuid primary key, flushed_at timestamptz not null default clock_timestamp());
    create index market_data_observations_instrument_event_at_idx on platform.market_data_observations(instrument_id,event_at desc);
    create index market_data_observations_latest_idx on platform.market_data_observations(instrument_id,ingested_at desc,id desc);
    create index market_data_quality_events_open_halt_idx on platform.market_data_quality_events(instrument_id,ingested_at desc) where requires_human_clear;
    create unique index market_data_quality_buckets_natural_key on platform.market_data_quality_buckets(provider_id,instrument_id,reason_code,bucket_started_at) nulls not distinct;

    create function platform.reject_market_data_history_mutation() returns trigger language plpgsql as $$ begin raise exception 'Market-data history is immutable.' using errcode = '55000'; end $$;
    create function platform.reject_market_data_history_truncate() returns trigger language plpgsql as $$ begin raise exception 'Market-data history cannot be truncated.' using errcode = '55000'; end $$;
    create function platform.reject_market_data_bucket_mutation() returns trigger language plpgsql as $$ begin if current_user <> 'platform_owner' then raise exception 'Market-data quality buckets are writable only by the aggregate append function.' using errcode = '42501'; end if; return new; end $$;

    create trigger market_data_observations_immutable before update or delete on platform.market_data_observations for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_observations_no_truncate before truncate on platform.market_data_observations for each statement execute function platform.reject_market_data_history_truncate();
    create trigger market_data_quality_events_immutable before update or delete on platform.market_data_quality_events for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_quality_events_no_truncate before truncate on platform.market_data_quality_events for each statement execute function platform.reject_market_data_history_truncate();
    create trigger market_data_halts_immutable before update or delete on platform.market_data_halts for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_halts_no_truncate before truncate on platform.market_data_halts for each statement execute function platform.reject_market_data_history_truncate();
    create trigger market_data_halt_resolutions_immutable before update or delete on platform.market_data_halt_resolutions for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_halt_resolutions_no_truncate before truncate on platform.market_data_halt_resolutions for each statement execute function platform.reject_market_data_history_truncate();
    create trigger market_data_jump_resets_immutable before update or delete on platform.market_data_jump_resets for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_jump_resets_no_truncate before truncate on platform.market_data_jump_resets for each statement execute function platform.reject_market_data_history_truncate();
    create trigger market_data_jump_reset_consumptions_immutable before update or delete on platform.market_data_jump_reset_consumptions for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_jump_reset_consumptions_no_truncate before truncate on platform.market_data_jump_reset_consumptions for each statement execute function platform.reject_market_data_history_truncate();
    create trigger market_data_quality_bucket_flushes_immutable before update or delete on platform.market_data_quality_bucket_flushes for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_quality_bucket_flushes_no_truncate before truncate on platform.market_data_quality_bucket_flushes for each statement execute function platform.reject_market_data_history_truncate();
    create trigger market_data_quality_buckets_guard before insert or update on platform.market_data_quality_buckets for each row execute function platform.reject_market_data_bucket_mutation();
    create trigger market_data_quality_buckets_immutable before delete on platform.market_data_quality_buckets for each row execute function platform.reject_market_data_history_mutation();
    create trigger market_data_quality_buckets_no_truncate before truncate on platform.market_data_quality_buckets for each statement execute function platform.reject_market_data_history_truncate();

    create view platform.market_data_effective_state with (security_barrier = true) as
    select p.instrument_id, s.provider_id, s.observation_id, s.provider_sequence, s.trade_id,
      s.bid_as_of_last_trade, s.bid_size_as_of_last_trade, s.ask_as_of_last_trade, s.ask_size_as_of_last_trade,
      s.last_trade_price, s.last_trade_size, s.volume_24h, s.event_at, s.ingested_at,
      case when not p.enabled then 'UNAVAILABLE_DISABLED_SCOPE'
           when s.instrument_id is null then 'UNAVAILABLE_STALE'
           when s.base_availability is null or s.base_availability <> 'AVAILABLE' then coalesce(s.base_availability, 'UNAVAILABLE_STALE')
           when s.observation_id is null or s.ingested_at is null or s.event_at is null then 'UNAVAILABLE_STALE'
           when s.ingested_at < clock_timestamp() - p.max_ingestion_age_ms * interval '1 millisecond' then 'UNAVAILABLE_STALE'
           when s.event_at < clock_timestamp() - p.max_event_age_ms * interval '1 millisecond' then 'UNAVAILABLE_STALE'
           when s.event_at > clock_timestamp() + p.max_future_skew_ms * interval '1 millisecond' then 'UNAVAILABLE_CLOCK_ANOMALY'
           else 'AVAILABLE' end as availability, clock_timestamp() as evaluated_at
    from platform.market_data_policies p left join platform.market_data_instrument_state s using (instrument_id);

    create function platform.open_market_data_halt(p_provider_id uuid,p_instrument_id uuid,p_reason_code text,p_event_at timestamptz,p_trade_id numeric,p_provider_sequence numeric,p_candidate_price numeric,p_candidate_size numeric,p_reference_price numeric)
    returns uuid language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_event uuid; v_halt uuid;
    begin
      insert into platform.market_data_instrument_state(instrument_id,provider_id,base_availability) values(p_instrument_id,p_provider_id,'UNAVAILABLE_REBASELINING') on conflict (instrument_id) do nothing;
      perform 1 from platform.market_data_instrument_state where instrument_id=p_instrument_id for update;
      if exists (select 1 from platform.market_data_halts h left join platform.market_data_halt_resolutions r on r.halt_id=h.id where h.instrument_id=p_instrument_id and r.id is null) then raise exception 'Market-data halt is already open.' using errcode='55000'; end if;
      if p_reason_code not in ('LOCKED_OR_CROSSED','OUT_OF_ORDER_MATCH_ID','IN_SESSION_MATCH_GAP','PRICE_JUMP','PRODUCT_ASSERTION_FAILURE','IDEMPOTENCY_CONFLICT') then raise exception 'Invalid market-data halt reason.' using errcode='22023'; end if;
      insert into platform.market_data_quality_events(provider_id,instrument_id,decision,requires_human_clear,reason_code,trade_id,provider_sequence,event_at,candidate_price,candidate_size)
      values(p_provider_id,p_instrument_id,case when p_reason_code='PRICE_JUMP' then 'QUARANTINE' else 'HALT' end,true,p_reason_code,p_trade_id,p_provider_sequence,p_event_at,p_candidate_price,p_candidate_size) returning id into v_event;
      insert into platform.market_data_halts(quality_event_id,instrument_id,reason_code,candidate_price,candidate_size,candidate_trade_id,candidate_provider_sequence,reference_price)
      values(v_event,p_instrument_id,p_reason_code,p_candidate_price,p_candidate_size,p_trade_id,p_provider_sequence,p_reference_price) returning id into v_halt;
      update platform.market_data_instrument_state set base_availability='UNAVAILABLE_HUMAN_HALT',updated_at=clock_timestamp() where instrument_id=p_instrument_id;
      return v_halt;
    end $$;

    create function platform.append_market_data_observation(p_provider_id uuid,p_instrument_id uuid,p_provider_symbol text,p_provider_sequence numeric,p_trade_id numeric,p_event_at_us numeric,p_event_at timestamptz,p_received_at timestamptz,p_bid numeric,p_bid_size numeric,p_ask numeric,p_ask_size numeric,p_last_price numeric,p_last_size numeric,p_volume_24h numeric)
    returns table(outcome text,observation_id uuid,halt_id uuid) language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_existing platform.market_data_observations%rowtype; v_observation uuid; v_halt uuid; v_reset platform.market_data_jump_resets%rowtype; v_reset_eligible boolean := false; v_state platform.market_data_instrument_state%rowtype;
    begin
      if not exists(select 1 from platform.market_data_policies where instrument_id=p_instrument_id and enabled) then raise exception 'Market-data policy is unavailable.' using errcode='23514'; end if;
      insert into platform.market_data_instrument_state(instrument_id,provider_id,base_availability) values(p_instrument_id,p_provider_id,'UNAVAILABLE_REBASELINING') on conflict(instrument_id) do nothing;
      select * into v_state from platform.market_data_instrument_state where instrument_id=p_instrument_id for update;
      select * into v_existing from platform.market_data_observations where provider_id=p_provider_id and instrument_id=p_instrument_id and trade_id=p_trade_id for update;
      if found then
        if v_existing.provider_symbol=p_provider_symbol and v_existing.provider_sequence=p_provider_sequence and v_existing.event_at_us=p_event_at_us and v_existing.event_at=p_event_at and v_existing.received_at=p_received_at and v_existing.bid_as_of_last_trade=p_bid and v_existing.bid_size_as_of_last_trade=p_bid_size and v_existing.ask_as_of_last_trade=p_ask and v_existing.ask_size_as_of_last_trade=p_ask_size and v_existing.last_trade_price=p_last_price and v_existing.last_trade_size=p_last_size and v_existing.volume_24h is not distinct from p_volume_24h then return query select 'DUPLICATE_IDENTICAL',v_existing.id,null::uuid; return; end if;
        v_halt:=platform.open_market_data_halt(p_provider_id,p_instrument_id,'IDEMPOTENCY_CONFLICT',p_event_at,p_trade_id,p_provider_sequence,null,null,null);
        return query select 'IDEMPOTENCY_CONFLICT',null::uuid,v_halt; return;
      end if;
      select r.* into v_reset from platform.market_data_jump_resets r where r.instrument_id=p_instrument_id order by r.id desc limit 1;
      if found and not exists(select 1 from platform.market_data_jump_reset_consumptions c where c.reset_id=v_reset.id) then
        v_reset_eligible:=true;
        if v_reset.expires_at <= clock_timestamp() or p_last_price < v_reset.confirmed_candidate_price*(1-v_reset.tolerance_bps::numeric/10000) or p_last_price > v_reset.confirmed_candidate_price*(1+v_reset.tolerance_bps::numeric/10000) then
          v_halt:=platform.open_market_data_halt(p_provider_id,p_instrument_id,'PRICE_JUMP',p_event_at,p_trade_id,p_provider_sequence,p_last_price,p_last_size,coalesce(v_state.last_accepted_price,v_reset.confirmed_candidate_price));
          return query select 'PRICE_JUMP_HALT',null::uuid,v_halt; return;
        end if;
      end if;
      if exists(select 1 from platform.market_data_halts h left join platform.market_data_halt_resolutions r on r.halt_id=h.id where h.instrument_id=p_instrument_id and r.id is null) then raise exception 'Market-data halt is open.' using errcode='55000'; end if;
      insert into platform.market_data_observations(provider_id,instrument_id,provider_symbol,provider_sequence,trade_id,event_at_us,event_at,received_at,bid_as_of_last_trade,bid_size_as_of_last_trade,ask_as_of_last_trade,ask_size_as_of_last_trade,last_trade_price,last_trade_size,volume_24h)
      values(p_provider_id,p_instrument_id,p_provider_symbol,p_provider_sequence,p_trade_id,p_event_at_us,p_event_at,p_received_at,p_bid,p_bid_size,p_ask,p_ask_size,p_last_price,p_last_size,p_volume_24h) returning id into v_observation;
      if v_reset_eligible then insert into platform.market_data_jump_reset_consumptions(reset_id,observation_id) values(v_reset.id,v_observation); end if;
      update platform.market_data_instrument_state set observation_id=v_observation,base_availability='AVAILABLE',event_at=p_event_at,ingested_at=clock_timestamp(),provider_sequence=p_provider_sequence,trade_id=p_trade_id,bid_as_of_last_trade=p_bid,bid_size_as_of_last_trade=p_bid_size,ask_as_of_last_trade=p_ask,ask_size_as_of_last_trade=p_ask_size,last_trade_price=p_last_price,last_trade_size=p_last_size,volume_24h=p_volume_24h,last_accepted_price=p_last_price,updated_at=clock_timestamp() where instrument_id=p_instrument_id;
      perform pg_notify('market_data_changed',p_instrument_id::text); return query select 'ACCEPTED',v_observation,null::uuid;
    end $$;
    create function platform.append_market_data_quality_bucket(p_flush_id uuid,p_provider_id uuid,p_instrument_id uuid,p_reason_code text,p_bucket_started_at timestamptz,p_count bigint)
    returns void language plpgsql security definer set search_path = pg_catalog, platform as $$
    begin
      if p_flush_id is null or p_provider_id is null or p_reason_code is null or length(btrim(p_reason_code)) = 0 or p_bucket_started_at is null or p_count is null or p_count <= 0 then raise exception 'Invalid market-data quality bucket.' using errcode = '22023'; end if;
      insert into platform.market_data_quality_bucket_flushes(flush_id) values(p_flush_id) on conflict(flush_id) do nothing;
      if not found then return; end if;
      insert into platform.market_data_quality_buckets(provider_id,instrument_id,reason_code,bucket_started_at,rejected_count)
      values(p_provider_id,p_instrument_id,p_reason_code,p_bucket_started_at,p_count)
      on conflict(provider_id,instrument_id,reason_code,bucket_started_at) do update
      set rejected_count = platform.market_data_quality_buckets.rejected_count + excluded.rejected_count, updated_at = clock_timestamp();
    end $$;

    create function platform.transition_market_data_state(p_provider_id uuid,p_new_base_availability text,p_reason_code text,p_instrument_id uuid default null)
    returns void language plpgsql security definer set search_path = pg_catalog, platform as $$
    begin
      if p_new_base_availability not in ('UNAVAILABLE_DISABLED_SCOPE','UNAVAILABLE_REBASELINING','UNAVAILABLE_PROVIDER_CIRCUIT','UNAVAILABLE_PERSISTENCE') or p_reason_code in ('LOCKED_OR_CROSSED','OUT_OF_ORDER_MATCH_ID','IN_SESSION_MATCH_GAP','PRICE_JUMP','PRODUCT_ASSERTION_FAILURE','IDEMPOTENCY_CONFLICT') then raise exception 'Invalid market-data state transition.' using errcode = '22023'; end if;
      if p_instrument_id is not null then
        insert into platform.market_data_instrument_state(instrument_id,provider_id,base_availability) values(p_instrument_id,p_provider_id,'UNAVAILABLE_REBASELINING') on conflict(instrument_id) do nothing;
        perform 1 from platform.market_data_instrument_state where instrument_id=p_instrument_id for update;
        if (select base_availability from platform.market_data_instrument_state where instrument_id=p_instrument_id) = 'UNAVAILABLE_HUMAN_HALT' then raise exception 'Market-data human halt cannot be cleared by transition.' using errcode = '55000'; end if;
        update platform.market_data_instrument_state set base_availability=p_new_base_availability,updated_at=clock_timestamp() where instrument_id=p_instrument_id and provider_id=p_provider_id;
        insert into platform.market_data_quality_events(provider_id,instrument_id,decision,requires_human_clear,reason_code) values(p_provider_id,p_instrument_id,'RECOVERY',false,p_reason_code);
      else
        update platform.market_data_instrument_state set base_availability=p_new_base_availability,updated_at=clock_timestamp() where provider_id=p_provider_id and base_availability <> 'UNAVAILABLE_HUMAN_HALT';
        insert into platform.market_data_quality_events(provider_id,instrument_id,decision,requires_human_clear,reason_code) values(p_provider_id,null,'RECOVERY',false,p_reason_code);
      end if;
    end $$;

    create function platform.market_data_startup_recovery(p_instrument_id uuid)
    returns table(last_accepted_price numeric,event_at timestamptz,halt_id uuid,halt_reason_code text,candidate_price numeric,candidate_size numeric,candidate_trade_id numeric,candidate_provider_sequence numeric,reference_price numeric,reset_id uuid,confirmed_candidate_price numeric,tolerance_bps integer,expires_at timestamptz)
    language sql security definer set search_path = pg_catalog, platform as $$
      select s.last_accepted_price,s.event_at,h.id,h.reason_code,h.candidate_price,h.candidate_size,h.candidate_trade_id,h.candidate_provider_sequence,h.reference_price,r.id,r.confirmed_candidate_price,r.tolerance_bps,r.expires_at
      from platform.market_data_instrument_state s
      left join lateral (select h1.* from platform.market_data_halts h1 left join platform.market_data_halt_resolutions hr on hr.halt_id=h1.id where h1.instrument_id=s.instrument_id and hr.id is null order by h1.opened_at desc limit 1) h on true
      left join lateral (select jr.* from platform.market_data_jump_resets jr where jr.instrument_id=s.instrument_id order by jr.id desc limit 1) newest_reset on true
      left join lateral (select newest_reset.* where newest_reset.id is not null and newest_reset.expires_at > clock_timestamp() and not exists(select 1 from platform.market_data_jump_reset_consumptions jc where jc.reset_id=newest_reset.id)) r on true
      where s.instrument_id=p_instrument_id
    $$;

    create function platform.list_open_market_data_halts()
    returns table(halt_id uuid,instrument_id uuid,reason_code text,candidate_price numeric,candidate_size numeric,candidate_trade_id numeric,candidate_provider_sequence numeric,reference_price numeric,opened_at timestamptz)
    language sql security definer set search_path = pg_catalog, platform as $$
      select h.id,h.instrument_id,h.reason_code,h.candidate_price,h.candidate_size,h.candidate_trade_id,h.candidate_provider_sequence,h.reference_price,h.opened_at
      from platform.market_data_halts h left join platform.market_data_halt_resolutions r on r.halt_id=h.id where r.id is null order by h.opened_at
    $$;

    create function platform.clear_market_data_halt(p_session_id uuid,p_session_secret text,p_halt_id uuid,p_instrument_id uuid,p_resolution_reason text,p_typed_candidate_price numeric)
    returns table(resolution_id uuid,instrument_id uuid,reset_expires_at timestamptz) language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_actor uuid; v_halt platform.market_data_halts%rowtype; v_resolution uuid; v_expiry timestamptz; v_policy platform.market_data_policies%rowtype;
    begin
      perform 1 from platform.market_data_instrument_state s where s.instrument_id=p_instrument_id for update;
      select user_id into v_actor from platform.require_authenticated_session(p_session_id,p_session_secret,'market_data.halt.clear',null);
      select h.* into v_halt from platform.market_data_halts h left join platform.market_data_halt_resolutions r on r.halt_id=h.id where h.id=p_halt_id and h.instrument_id=p_instrument_id and r.id is null;
      if not found then raise exception 'Market-data halt is unavailable.' using errcode='23514'; end if;
      if length(btrim(coalesce(p_resolution_reason,''))) not between 1 and 500 then raise exception 'Invalid market-data halt resolution reason.' using errcode='22023'; end if;
      if (v_halt.reason_code='PRICE_JUMP' and p_typed_candidate_price is distinct from v_halt.candidate_price) or (v_halt.reason_code <> 'PRICE_JUMP' and p_typed_candidate_price is not null) then raise exception 'Market-data halt candidate confirmation is invalid.' using errcode='22023'; end if;
      insert into platform.market_data_halt_resolutions(halt_id,actor_user_id,actor_session_id,resolution_reason,confirmed_candidate_price) values(v_halt.id,v_actor,p_session_id,p_resolution_reason,p_typed_candidate_price) returning id into v_resolution;
      perform platform.append_audit_event('market_data_halt_cleared','success',v_actor,v_actor,null,p_session_id,null,jsonb_build_object('halt_id',v_halt.id,'instrument_id',p_instrument_id));
      if v_halt.reason_code='PRICE_JUMP' then
        select p.* into v_policy from platform.market_data_policies p where p.instrument_id=p_instrument_id;
        v_expiry:=clock_timestamp()+v_policy.jump_reset_ttl_ms*interval '1 millisecond';
        insert into platform.market_data_jump_resets(instrument_id,resolution_id,confirmed_candidate_price,tolerance_bps,expires_at) values(p_instrument_id,v_resolution,v_halt.candidate_price,v_policy.jump_reset_tolerance_bps,v_expiry);
      end if;
      update platform.market_data_instrument_state s set base_availability='UNAVAILABLE_REBASELINING',updated_at=clock_timestamp() where s.instrument_id=p_instrument_id;
      return query select v_resolution,p_instrument_id,v_expiry;
    end $$;

    create function platform.apply_market_data_catalog_manifest(p_manifest jsonb)
    returns void language plpgsql security definer set search_path = pg_catalog, platform as $$
    declare v_item jsonb; v_policy jsonb; v_key text; v_market uuid; v_provider uuid; v_instrument uuid;
    begin
      if p_manifest is null or jsonb_typeof(p_manifest) <> 'object' or not (p_manifest ? 'manifest_version') or not (p_manifest ? 'provider') or not (p_manifest ? 'market') or not (p_manifest ? 'instruments') or p_manifest->>'manifest_version' <> '1' or coalesce(jsonb_typeof(p_manifest->'provider'),'') <> 'object' or coalesce(jsonb_typeof(p_manifest->'market'),'') <> 'object' or coalesce(jsonb_typeof(p_manifest->'instruments'),'') <> 'array' then raise exception 'Invalid market-data catalog manifest.' using errcode='22023'; end if;
      if exists(select 1 from jsonb_object_keys(p_manifest) k where k not in ('manifest_version','provider','market','instruments')) or exists(select 1 from jsonb_object_keys(p_manifest->'provider') k where k <> 'provider_code') or exists(select 1 from jsonb_object_keys(p_manifest->'market') k where k not in ('market_code','enabled')) then raise exception 'Unknown market-data catalog manifest key.' using errcode='22023'; end if;
      if coalesce(jsonb_typeof(p_manifest->'manifest_version'),'') <> 'number' or coalesce(jsonb_typeof(p_manifest->'provider'->'provider_code'),'') <> 'string' or coalesce(jsonb_typeof(p_manifest->'market'->'market_code'),'') <> 'string' or coalesce(jsonb_typeof(p_manifest->'market'->'enabled'),'') <> 'boolean' or coalesce(p_manifest->'provider'->>'provider_code','') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or coalesce(p_manifest->'market'->>'market_code','') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then raise exception 'Invalid market-data catalog manifest value.' using errcode='22023'; end if;
      insert into platform.providers(provider_code) values(p_manifest->'provider'->>'provider_code') on conflict(provider_code) do nothing;
      select id into v_provider from platform.providers where provider_code=p_manifest->'provider'->>'provider_code';
      insert into platform.markets(market_code,enabled) values(p_manifest->'market'->>'market_code',(p_manifest->'market'->>'enabled')::boolean) on conflict(market_code) do update set enabled=excluded.enabled where platform.markets.enabled is distinct from excluded.enabled;
      select id into v_market from platform.markets where market_code=p_manifest->'market'->>'market_code';
      for v_item in select value from jsonb_array_elements(p_manifest->'instruments') loop
        if coalesce(jsonb_typeof(v_item),'') <> 'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('instrument_code','provider_symbol','enabled','price_increment','size_increment','policy')) or coalesce(jsonb_typeof(v_item->'instrument_code'),'') <> 'string' or coalesce(jsonb_typeof(v_item->'provider_symbol'),'') <> 'string' or coalesce(jsonb_typeof(v_item->'enabled'),'') <> 'boolean' or coalesce(jsonb_typeof(v_item->'policy'),'') <> 'object' or coalesce(v_item->>'instrument_code','') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or coalesce(v_item->>'provider_symbol','') = '' then raise exception 'Invalid market-data catalog instrument.' using errcode='22023'; end if;
        if (coalesce(jsonb_typeof(v_item->'price_increment'),'') not in ('','null','string')) or (coalesce(jsonb_typeof(v_item->'size_increment'),'') not in ('','null','string')) or (jsonb_typeof(v_item->'price_increment') = 'string' and (v_item->>'price_increment' !~ '^(0|[1-9][0-9]{0,19})(\\.[0-9]{1,18})?$' or (v_item->>'price_increment')::numeric <= 0)) or (jsonb_typeof(v_item->'size_increment') = 'string' and (v_item->>'size_increment' !~ '^(0|[1-9][0-9]{0,19})(\\.[0-9]{1,18})?$' or (v_item->>'size_increment')::numeric <= 0)) or ((v_item->>'enabled')::boolean and (coalesce(jsonb_typeof(v_item->'price_increment'),'') <> 'string' or coalesce(jsonb_typeof(v_item->'size_increment'),'') <> 'string')) then raise exception 'Invalid market-data increment.' using errcode='22023'; end if;
        v_policy:=v_item->'policy';
        if exists(select 1 from jsonb_object_keys(v_policy) k where k not in ('enabled','max_ingestion_age_ms','max_event_age_ms','max_future_skew_ms','max_initial_event_delay_ms','max_price_jump_bps','heartbeat_timeout_ms','circuit_failure_threshold','circuit_failure_window_ms','circuit_cooldown_ms','circuit_half_open_ready_ms','heartbeat_ahead_count','heartbeat_ahead_span_ms','heartbeat_settle_count','heartbeat_settle_span_ms','jump_reset_tolerance_bps','jump_reset_ttl_ms')) or coalesce(jsonb_typeof(v_policy->'enabled'),'') <> 'boolean' then raise exception 'Invalid market-data policy.' using errcode='22023'; end if;
        for v_key in select key from jsonb_object_keys(v_policy) key where key <> 'enabled' loop if jsonb_typeof(v_policy->v_key) <> 'number' or v_policy->>v_key !~ '^[0-9]+$' then raise exception 'Invalid market-data policy value.' using errcode='22023'; end if; end loop;
        insert into platform.instruments(market_id,instrument_code,enabled,price_increment,size_increment) values(v_market,v_item->>'instrument_code',(v_item->>'enabled')::boolean,nullif(v_item->>'price_increment','')::numeric,nullif(v_item->>'size_increment','')::numeric) on conflict(market_id,instrument_code) do update set enabled=excluded.enabled,price_increment=excluded.price_increment,size_increment=excluded.size_increment where platform.instruments.enabled is distinct from excluded.enabled or platform.instruments.price_increment is distinct from excluded.price_increment or platform.instruments.size_increment is distinct from excluded.size_increment;
        select id into v_instrument from platform.instruments where market_id=v_market and instrument_code=v_item->>'instrument_code';
        insert into platform.provider_instrument_symbols(provider_id,instrument_id,provider_symbol,enabled) values(v_provider,v_instrument,v_item->>'provider_symbol',(v_item->>'enabled')::boolean) on conflict(provider_id,instrument_id) do update set enabled=excluded.enabled where platform.provider_instrument_symbols.provider_symbol=excluded.provider_symbol and platform.provider_instrument_symbols.enabled is distinct from excluded.enabled;
        if not exists(select 1 from platform.provider_instrument_symbols where provider_id=v_provider and instrument_id=v_instrument and provider_symbol=v_item->>'provider_symbol') then raise exception 'Provider symbol conflicts with existing catalog mapping.' using errcode='23505'; end if;
        insert into platform.market_data_policies(instrument_id,enabled,max_ingestion_age_ms,max_event_age_ms,max_future_skew_ms,max_initial_event_delay_ms,max_price_jump_bps,heartbeat_timeout_ms,circuit_failure_threshold,circuit_failure_window_ms,circuit_cooldown_ms,circuit_half_open_ready_ms,heartbeat_ahead_count,heartbeat_ahead_span_ms,heartbeat_settle_count,heartbeat_settle_span_ms,jump_reset_tolerance_bps,jump_reset_ttl_ms) values(v_instrument,(v_policy->>'enabled')::boolean,coalesce((v_policy->>'max_ingestion_age_ms')::integer,10000),coalesce((v_policy->>'max_event_age_ms')::integer,10000),coalesce((v_policy->>'max_future_skew_ms')::integer,2000),coalesce((v_policy->>'max_initial_event_delay_ms')::integer,5000),coalesce((v_policy->>'max_price_jump_bps')::integer,2000),coalesce((v_policy->>'heartbeat_timeout_ms')::integer,5000),coalesce((v_policy->>'circuit_failure_threshold')::integer,5),coalesce((v_policy->>'circuit_failure_window_ms')::integer,60000),coalesce((v_policy->>'circuit_cooldown_ms')::integer,30000),coalesce((v_policy->>'circuit_half_open_ready_ms')::integer,10000),coalesce((v_policy->>'heartbeat_ahead_count')::integer,4),coalesce((v_policy->>'heartbeat_ahead_span_ms')::integer,2500),coalesce((v_policy->>'heartbeat_settle_count')::integer,4),coalesce((v_policy->>'heartbeat_settle_span_ms')::integer,3000),coalesce((v_policy->>'jump_reset_tolerance_bps')::integer,100),coalesce((v_policy->>'jump_reset_ttl_ms')::integer,300000)) on conflict(instrument_id) do update set enabled=excluded.enabled,max_ingestion_age_ms=excluded.max_ingestion_age_ms,max_event_age_ms=excluded.max_event_age_ms,max_future_skew_ms=excluded.max_future_skew_ms,max_initial_event_delay_ms=excluded.max_initial_event_delay_ms,max_price_jump_bps=excluded.max_price_jump_bps,heartbeat_timeout_ms=excluded.heartbeat_timeout_ms,circuit_failure_threshold=excluded.circuit_failure_threshold,circuit_failure_window_ms=excluded.circuit_failure_window_ms,circuit_cooldown_ms=excluded.circuit_cooldown_ms,circuit_half_open_ready_ms=excluded.circuit_half_open_ready_ms,heartbeat_ahead_count=excluded.heartbeat_ahead_count,heartbeat_ahead_span_ms=excluded.heartbeat_ahead_span_ms,heartbeat_settle_count=excluded.heartbeat_settle_count,heartbeat_settle_span_ms=excluded.heartbeat_settle_span_ms,jump_reset_tolerance_bps=excluded.jump_reset_tolerance_bps,jump_reset_ttl_ms=excluded.jump_reset_ttl_ms,updated_at=clock_timestamp() where (platform.market_data_policies.enabled,platform.market_data_policies.max_ingestion_age_ms,platform.market_data_policies.max_event_age_ms,platform.market_data_policies.max_future_skew_ms,platform.market_data_policies.max_initial_event_delay_ms,platform.market_data_policies.max_price_jump_bps,platform.market_data_policies.heartbeat_timeout_ms,platform.market_data_policies.circuit_failure_threshold,platform.market_data_policies.circuit_failure_window_ms,platform.market_data_policies.circuit_cooldown_ms,platform.market_data_policies.circuit_half_open_ready_ms,platform.market_data_policies.heartbeat_ahead_count,platform.market_data_policies.heartbeat_ahead_span_ms,platform.market_data_policies.heartbeat_settle_count,platform.market_data_policies.heartbeat_settle_span_ms,platform.market_data_policies.jump_reset_tolerance_bps,platform.market_data_policies.jump_reset_ttl_ms) is distinct from (excluded.enabled,excluded.max_ingestion_age_ms,excluded.max_event_age_ms,excluded.max_future_skew_ms,excluded.max_initial_event_delay_ms,excluded.max_price_jump_bps,excluded.heartbeat_timeout_ms,excluded.circuit_failure_threshold,excluded.circuit_failure_window_ms,excluded.circuit_cooldown_ms,excluded.circuit_half_open_ready_ms,excluded.heartbeat_ahead_count,excluded.heartbeat_ahead_span_ms,excluded.heartbeat_settle_count,excluded.heartbeat_settle_span_ms,excluded.jump_reset_tolerance_bps,excluded.jump_reset_ttl_ms);
      end loop;
      perform platform.append_audit_event('catalog_manifest_applied','system',null,null,null,null,null,jsonb_build_object('sha256',encode(public.digest(convert_to(p_manifest::text,'UTF8'),'sha256'),'hex')));
    end $$;

    create or replace function platform.require_authenticated_session(p_session_id uuid, p_session_secret text, p_required_permission text, p_account_id uuid default null)
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
      if p_required_permission like 'ledger.post.%'
         or p_required_permission in ('password.reset.issue', 'market_data.halt.clear') then
        select exists(select 1 from platform.account_role_assignments r where r.user_id = v_user and r.role = 'SUPER_ADMIN' and r.enabled) into v_role_ok;
      else
        select exists(select 1 from platform.account_role_assignments r where r.user_id = v_user and r.account_id = p_account_id and r.enabled) into v_role_ok;
      end if;
      if not v_role_ok then raise exception 'Authorization is required.' using errcode = '42501'; end if;
      update platform.auth_sessions set idle_expires_at = least(absolute_expires_at, current_timestamp + interval '30 minutes') where id = p_session_id;
      return query select v_user, p_session_id;
    end; $$;

    alter table platform.market_data_policies owner to platform_owner;
    alter table platform.market_data_observations owner to platform_owner;
    alter table platform.market_data_instrument_state owner to platform_owner;
    alter table platform.market_data_quality_events owner to platform_owner;
    alter table platform.market_data_halts owner to platform_owner;
    alter table platform.market_data_halt_resolutions owner to platform_owner;
    alter table platform.market_data_jump_resets owner to platform_owner;
    alter table platform.market_data_jump_reset_consumptions owner to platform_owner;
    alter table platform.market_data_quality_buckets owner to platform_owner;
    alter table platform.market_data_quality_bucket_flushes owner to platform_owner;
    alter view platform.market_data_effective_state owner to platform_owner;
    alter function platform.open_market_data_halt(uuid,uuid,text,timestamptz,numeric,numeric,numeric,numeric,numeric) owner to platform_owner;
    alter function platform.append_market_data_observation(uuid,uuid,text,numeric,numeric,numeric,timestamptz,timestamptz,numeric,numeric,numeric,numeric,numeric,numeric,numeric) owner to platform_owner;
    alter function platform.append_market_data_quality_bucket(uuid,uuid,uuid,text,timestamptz,bigint) owner to platform_owner;
    alter function platform.transition_market_data_state(uuid,text,text,uuid) owner to platform_owner;
    alter function platform.market_data_startup_recovery(uuid) owner to platform_owner;
    alter function platform.clear_market_data_halt(uuid,text,uuid,uuid,text,numeric) owner to platform_owner;
    alter function platform.list_open_market_data_halts() owner to platform_owner;
    alter function platform.apply_market_data_catalog_manifest(jsonb) owner to platform_owner;
    revoke all on schema platform from public;
    revoke all on all tables in schema platform from public;
    revoke all on all sequences in schema platform from public;
    revoke all on all functions in schema platform from public;
    grant usage on schema platform to platform_owner,platform_market_data,platform_market_data_operator,platform_catalog_provisioner,platform_market_data_consumer;
    grant select (id,enabled) on platform.providers to platform_market_data,platform_owner;
    grant select (id,market_id,enabled,price_increment,size_increment) on platform.instruments to platform_market_data,platform_owner;
    grant select (id,enabled) on platform.markets to platform_market_data,platform_owner;
    grant select (provider_id,instrument_id,provider_symbol,enabled) on platform.provider_instrument_symbols to platform_market_data,platform_owner;
    grant select on platform.market_data_policies to platform_market_data;
    grant select (id,market_code,enabled) on platform.markets to platform_owner; grant insert (market_code,enabled) on platform.markets to platform_owner; grant update (enabled) on platform.markets to platform_owner;
    grant select (id,provider_code) on platform.providers to platform_owner; grant insert (provider_code) on platform.providers to platform_owner;
    grant select (id,market_id,instrument_code,enabled,price_increment,size_increment) on platform.instruments to platform_owner; grant insert (market_id,instrument_code,enabled,price_increment,size_increment) on platform.instruments to platform_owner; grant update (enabled,price_increment,size_increment) on platform.instruments to platform_owner;
    grant insert (provider_id,instrument_id,provider_symbol,enabled) on platform.provider_instrument_symbols to platform_owner; grant update (enabled) on platform.provider_instrument_symbols to platform_owner;
    grant execute on function platform.append_market_data_observation(uuid,uuid,text,numeric,numeric,numeric,timestamptz,timestamptz,numeric,numeric,numeric,numeric,numeric,numeric,numeric), platform.append_market_data_quality_bucket(uuid,uuid,uuid,text,timestamptz,bigint), platform.transition_market_data_state(uuid,text,text,uuid), platform.market_data_startup_recovery(uuid), platform.open_market_data_halt(uuid,uuid,text,timestamptz,numeric,numeric,numeric,numeric,numeric) to platform_market_data;
    grant execute on function platform.clear_market_data_halt(uuid,text,uuid,uuid,text,numeric), platform.list_open_market_data_halts() to platform_market_data_operator;
    grant execute on function platform.apply_market_data_catalog_manifest(jsonb) to platform_catalog_provisioner;
    grant select on platform.market_data_effective_state to platform_market_data_consumer;
    revoke all on function platform.append_audit_event(text,text,uuid,uuid,uuid,uuid,uuid,jsonb), platform.require_authenticated_session(uuid,text,text,uuid) from public,platform_market_data,platform_market_data_operator,platform_catalog_provisioner,platform_market_data_consumer;
    grant execute on function platform.append_audit_event(text,text,uuid,uuid,uuid,uuid,uuid,jsonb), platform.require_authenticated_session(uuid,text,text,uuid) to platform_owner;
    alter default privileges for role platform_owner in schema platform revoke all on tables from public;
    alter default privileges for role platform_owner in schema platform revoke execute on functions from public;
  `).execute(database);
}
