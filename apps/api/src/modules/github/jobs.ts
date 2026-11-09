import type { Pool } from 'pg';
import { withTransaction } from '@agentzero/database';
import { recordGithubTaskEvent } from '../tasks/maintenance.js';
import { enqueueContributionEvents } from '../contributions/jobs.js';

export async function processGithubDeliveries(pool:Pool):Promise<number> {
  let processed=0;
  for(let count=0;count<25;count++) {
    const found=await withTransaction(pool,async tx=>{
      const delivery=(await tx.query(`SELECT delivery_id,event_name,payload FROM github_deliveries
        WHERE status='pending' AND next_attempt_at<=clock_timestamp() ORDER BY created_at,delivery_id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if(!delivery) return false;
      await tx.query('SAVEPOINT process_delivery');
      try {
        const payload=delivery.payload;
        if(['pull_request','check_run','check_suite','status'].includes(delivery.event_name) && payload.repository?.id) {
          await recordGithubTaskEvent(tx,{
            repositoryGithubId:String(payload.repository.id),prNumber:payload.pull_request?.number??(delivery.event_name==='pull_request'?payload.number:undefined),
            headSha:payload.pull_request?.head?.sha??payload.check_run?.head_sha??payload.check_suite?.head_sha??payload.sha,
            deliveryId:delivery.delivery_id,eventName:delivery.event_name,
          });
        }
        await enqueueContributionEvents(tx,delivery.delivery_id,delivery.event_name,payload);
        await tx.query("UPDATE github_deliveries SET status='processed',attempts=attempts+1,last_error=NULL,processed_at=clock_timestamp() WHERE delivery_id=$1",[delivery.delivery_id]);
        processed++;
      } catch(error) {
        await tx.query('ROLLBACK TO SAVEPOINT process_delivery');
        // Store only a controlled code, never an upstream body or credentials.
        const code=typeof (error as {code?:unknown}).code==='string'?String((error as {code:string}).code).slice(0,80):'PROCESSING_FAILED';
        await tx.query(`UPDATE github_deliveries SET attempts=attempts+1,last_error=$2,
          next_attempt_at=clock_timestamp()+LEAST(300,5*power(2,LEAST(attempts,6))) * interval '1 second' WHERE delivery_id=$1`,[delivery.delivery_id,code]);
      }
      await tx.query('RELEASE SAVEPOINT process_delivery');
      return true;
    });
    if(!found) break;
  }
  return processed;
}
