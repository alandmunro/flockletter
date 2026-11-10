import express,{type Express} from 'express';
import { rateLimit } from 'express-rate-limit';
import { platformCommands,type PlatformCommand } from '../../shared/platform.js';
import { AppError } from '../errors.js';
import type { Config } from '../config.js';
import type { PlatformService } from './service.js';
export function platformRoutes(app:Express,config:Config,service?:PlatformService){
 app.use('/api/operator',rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false}), (req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(req.get('sec-fetch-site')==='cross-site'||(req.get('origin')&&!config.browserOrigins.includes(req.get('origin')!)))return next(new AppError(403,'origin_rejected','This browser origin is not authorized.'));
  if(!service)return next(new AppError(503,'operator_not_configured','Platform operator controls are not configured.'));
  next();
 });
 app.get('/api/operator/v1/schema',async(req,res)=>{await service!.options.identity.authenticate(req);res.json({commands:Object.fromEntries(Object.entries(platformCommands).map(([name,c])=>[name,{description:c.description,mutation:c.mutation,inputSchema:c.schema.toJSONSchema({io:'input'})}]))});});
 app.post('/api/operator/v1/commands/:name',async(req,res,next)=>{
  let actor;try{actor=await service!.options.identity.authenticate(req);}catch(error){if(error instanceof AppError&&['operator_mfa_required','operator_first_factor_required'].includes(error.code)){res.status(403).json({clerk_error:{type:'forbidden',reason:'reverification-error',metadata:{reverification:{level:error.code==='operator_mfa_required'?'multi_factor':'first_factor',afterMinutes:5}}}});return;}throw error;}
  const name=String(req.params.name);if(!Object.hasOwn(platformCommands,name))throw new AppError(404,'unknown_command','This operator command is unavailable.');
  if(!req.is('application/json'))throw new AppError(415,'json_required','Send application/json.');
  express.json({limit:'32kb',strict:true})(req,res,error=>{if(error)return next(error);void service!.execute(name as PlatformCommand,req.body,actor).then(result=>res.json({result})).catch(next);});
 });
}
