import { httpError, json, readJson } from "../lib/http.mjs";
function service(runtime){if(!runtime.aiChangeTracking)throw httpError(503,"AI Change Tracking service 尚未载入。",{code:"AI_CHANGE_TRACKING_UNAVAILABLE"});return runtime.aiChangeTracking;}
export function registerAiChangeTrackingRoutes(router){
  router.get("/api/ai-changes/status",async(_req,res,runtime)=>json(res,200,{ok:true,schema:await service(runtime).schemaStatus()}));
  router.get("/api/ai-changes",async(req,res,runtime)=>{const url=new URL(req.url,`http://${runtime.host}:${runtime.port}`);const tasks=await service(runtime).list({status:url.searchParams.get("status")||""});json(res,200,{ok:true,count:tasks.length,tasks});});
  router.get("/api/ai-changes/detail",async(req,res,runtime)=>{const url=new URL(req.url,`http://${runtime.host}:${runtime.port}`);json(res,200,{ok:true,...await service(runtime).detail(url.searchParams.get("taskId")||"")});});
  router.get("/api/ai-changes/resume-package",async(req,res,runtime)=>{const url=new URL(req.url,`http://${runtime.host}:${runtime.port}`);json(res,200,{ok:true,resumePackage:await service(runtime).resumePackage(url.searchParams.get("taskId")||"")});});
  router.post("/api/ai-changes",async(req,res,runtime)=>json(res,201,{ok:true,...await service(runtime).create(await readJson(req))}));
  for(const [route,method] of [["approve","approve"],["start-step","start"],["file","recordFile"],["test","recordTest"],["complete-step","completeStep"],["review","review"],["complete","complete"],["rollback","rollback"],["pause","pause"]]) router.post(`/api/ai-changes/${route}`,async(req,res,runtime)=>json(res,200,{ok:true,...await service(runtime)[method](await readJson(req))}));
}
