#!/usr/bin/env -S node --experimental-strip-types
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root=resolve(process.argv[2]??process.cwd()); const tasksPath=resolve(process.argv[3]??"evaluation/tasks.json"); const out=resolve(process.argv[4]??".atelier/evaluation"); mkdirSync(out,{recursive:true});
const tasks=JSON.parse(readFileSync(tasksPath,"utf8")) as Array<{id:string;query:string;repos?:string[]}>;
const report=[]; for(const task of tasks){ const started=Date.now(); const args=["--root",root,"code","search",task.query,"--json",...(task.repos?.length?["--repo",task.repos.join(",")]:[])]; const result=spawnSync("node",["--experimental-strip-types","apps/cli/src/main.ts",...args],{cwd:root,encoding:"utf8"}); report.push({task,...task,status:result.status,durationMs:Date.now()-started,stdout:result.stdout,stderr:result.stderr}); }
writeFileSync(resolve(out,`codesearch-${Date.now()}.json`),JSON.stringify({generatedAt:new Date().toISOString(),root,report},null,2));
