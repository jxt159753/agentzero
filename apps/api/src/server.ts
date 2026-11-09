import { buildApp } from './app.js';
import { loadConfig } from './config.js';
const config=loadConfig();
const app=await buildApp({config,logger:true,serveWeb:config.production,runJobs:true});
await app.listen({host:config.host,port:config.port});
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
