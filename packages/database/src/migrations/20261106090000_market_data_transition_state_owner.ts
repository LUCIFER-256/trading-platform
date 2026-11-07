import { sql, type Kysely } from "kysely";

/**
 * Refuses an instrument-scoped market-data state transition that names a provider
 * other than the one that owns the instrument's state row. Before this migration a
 * second provider mapped to the same instrument passed the mapping check, changed
 * no state, and still wrote a RECOVERY event under its own name. The state table is
 * keyed by instrument, so one provider owns each instrument's state; whether and how
 * a second provider may carry its own state is a separate design decision. Ownership
 * and grants are unchanged.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    create or replace function platform.transition_market_data_state(p_provider_id uuid,p_new_base_availability
      text,p_reason_code text,p_instrument_id uuid default null)
    returns void language plpgsql security definer set search_path = pg_catalog, platform as $$
    begin
      if p_new_base_availability not in
        ('UNAVAILABLE_DISABLED_SCOPE','UNAVAILABLE_REBASELINING','UNAVAILABLE_PROVIDER_CIRCUIT','UNAVAILABLE_PERSISTENCE') or
        p_reason_code in
        ('LOCKED_OR_CROSSED','OUT_OF_ORDER_MATCH_ID','IN_SESSION_MATCH_GAP','PRICE_JUMP','PRODUCT_ASSERTION_FAILURE','IDEMPOTENCY_CONFLICT')
        then raise exception 'Invalid market-data state transition.' using errcode = '22023'; end if;
      if p_instrument_id is not null then
        if not exists (select 1 from platform.provider_instrument_symbols m where m.provider_id=p_provider_id and
          m.instrument_id=p_instrument_id) then raise exception 'Market-data instrument is not mapped to the provider.' using errcode =
          '22023'; end if;
        insert into platform.market_data_instrument_state(instrument_id,provider_id,base_availability)
          values(p_instrument_id,p_provider_id,'UNAVAILABLE_REBASELINING') on conflict(instrument_id) do nothing;
        perform 1 from platform.market_data_instrument_state where instrument_id=p_instrument_id for update;
        if exists (select 1 from platform.market_data_instrument_state where instrument_id=p_instrument_id and
          provider_id<>p_provider_id) then raise exception 'Market-data instrument state belongs to another provider.' using errcode =
          '55000'; end if;
        if (select base_availability from platform.market_data_instrument_state where instrument_id=p_instrument_id) =
          'UNAVAILABLE_HUMAN_HALT' then raise exception 'Market-data human halt cannot be cleared by transition.' using errcode =
          '55000'; end if;
        update platform.market_data_instrument_state set
          base_availability=p_new_base_availability,updated_at=clock_timestamp() where instrument_id=p_instrument_id and
          provider_id=p_provider_id;
        insert into platform.market_data_quality_events(provider_id,instrument_id,decision,requires_human_clear,reason_code)
          values(p_provider_id,p_instrument_id,'RECOVERY',false,p_reason_code);
      else
        update platform.market_data_instrument_state set
          base_availability=p_new_base_availability,updated_at=clock_timestamp() where provider_id=p_provider_id and base_availability
          <> 'UNAVAILABLE_HUMAN_HALT';
        insert into platform.market_data_quality_events(provider_id,instrument_id,decision,requires_human_clear,reason_code)
          values(p_provider_id,null,'RECOVERY',false,p_reason_code);
      end if;
    end $$;
  `,
    )
    .execute(database);
}
