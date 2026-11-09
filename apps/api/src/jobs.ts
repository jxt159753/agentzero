import type { Pool } from 'pg';
import { processGithubDeliveries } from './modules/github/jobs.js';
import { processTaskDeadlines } from './modules/tasks/maintenance.js';
import { processGameTimeouts } from './modules/games/jobs.js';
import { processContributionEvents } from './modules/contributions/jobs.js';
import { processContributionHistory } from './modules/contributions/history.js';
import type { GitHubRepositoryProvider } from './modules/github/provider.js';

export function startJobs(pool:Pool,onError:(error:unknown)=>void,provider:GitHubRepositoryProvider) {
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  let running:Promise<void>=Promise.resolve();
  const tick=()=>{
    running=(async()=>{
      try {await processGithubDeliveries(pool);await processContributionHistory(pool,provider);await processContributionEvents(pool,provider);await processTaskDeadlines(pool);await processGameTimeouts(pool);} catch(error) {onError(error);}
      if(!stopped) {timer=setTimeout(tick,30_000);timer.unref();}
    })();
  };
  tick();
  return async()=>{stopped=true;clearTimeout(timer);await running;};
}
