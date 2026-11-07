// Serveur : la clé reste secrète (variable SPORTMONKS_TOKEN)
const BASE="https://api.sportmonks.com/v3/football";
function frErreur(code,msg){
  msg=String(msg||"");
  if(code===401||/unauthor|invalid.*token|token/i.test(msg))return "Clé API Sportmonks invalide ou manquante.";
  if(code===403||/plan|subscription|access/i.test(msg))return "Votre abonnement Sportmonks ne donne pas accès à cette ligue ou à cette donnée.";
  if(code===429||/rate|too many/i.test(msg))return "Limite de requêtes Sportmonks atteinte. Réessayez dans une minute.";
  return "Erreur Sportmonks : "+msg;
}
async function api(path,params={}){
  let r,j;
  try{
    r=await fetch(BASE+path+"?"+new URLSearchParams({api_token:process.env.SPORTMONKS_TOKEN,...params}));
    j=await r.json();
  }catch(e){throw new Error("Impossible de joindre Sportmonks. Réessayez dans un instant.")}
  if(j.data===undefined){
    if(/no result/i.test(j.message||""))return[];
    throw new Error(frErreur(r.status,j.message));
  }
  return j.data;
}
const pois=(l,k)=>Math.exp(-l)*Math.pow(l,k)/[1,1,2,6,24,120][k];
const ymd=d=>d.toLocaleDateString("en-CA");
const utc=s=>new Date(s.replace(" ","T")+"Z");
function goals(f){let h=0,a=0;(f.scores||[]).filter(x=>x.description==="CURRENT").forEach(x=>{if(x.score.participant==="home")h=x.score.goals;else a=x.score.goals});return[h,a]}
async function findTeam(n){return (await api("/teams/search/"+encodeURIComponent(n),{include:"country"}))[0]}
const tname=t=>t.name+(t.country&&t.country.name?" ("+t.country.name+")":"");
async function form(team){
 const to=new Date(Date.now()-864e5),from=new Date(Date.now()-90*864e5);
 const f=(await api("/fixtures/between/"+ymd(from)+"/"+ymd(to)+"/"+team.id,{include:"participants;scores;statistics"}))
  .filter(m=>(m.scores||[]).length).sort((a,b)=>a.starting_at<b.starting_at?-1:1).slice(-5);
 let gf=0,ga=0,yc=0;const res=[];
 f.forEach(m=>{
  const me=m.participants.find(p=>p.id===team.id),opp=m.participants.find(p=>p.id!==team.id);
  const [h,a]=goals(m),home=me.meta.location==="home",x=home?h:a,y=home?a:h;
  gf+=x;ga+=y;res.push((x>y?"V":x===y?"N":"D")+" "+x+"-"+y+" vs "+opp.name);
  yc+=(m.statistics||[]).filter(t=>t.type_id===84&&t.participant_id===team.id).reduce((t,s)=>t+Number((s.data&&s.data.value)||0),0);
 });
 const n=f.length||1;return{resultats:res,gf:gf/n,ga:ga/n,jaunes:yc/n,n:f.length}
}
async function analyse(home,away){
 const [A,B]=await Promise.all([findTeam(home),findTeam(away)]);
 if(!A||!B)return{erreur:"Équipe introuvable. Vérifiez l’orthographe (nom en anglais de préférence)."};
 const today=ymd(new Date()),tom=ymd(new Date(Date.now()+864e5));
 const fxs=await api("/fixtures/between/"+today+"/"+tom+"/"+A.id,{include:"participants;league;venue;referees.referee"});
 const fx=fxs.filter(m=>m.participants.some(p=>p.id===B.id)).sort((a,b)=>a.starting_at<b.starting_at?-1:1)[0];
 if(!fx||ymd(utc(fx.starting_at))!==today)return{confirme:false,message:tname(A)+" – "+tname(B)+" : aucun match programmé aujourd’hui ("+today+")."+(fx?" Prochain match trouvé : "+utc(fx.starting_at).toLocaleString("fr-FR")+".":"")};
 const [fa,fb,h2h]=await Promise.all([form(A),form(B),api("/fixtures/head-to-head/"+A.id+"/"+B.id,{include:"participants;scores"})]);
 let absents=[];
 try{
  const sf=await api("/fixtures/"+fx.id,{include:"sidelined.sideline.player;sidelined.sideline.type"});
  absents=(sf.sidelined||[]).map(x=>{
   const sl=x.sideline||{},pl=sl.player||{},tm=[A,B].find(t=>t.id===x.participant_id);
   return (pl.display_name||pl.name||"Joueur")+(tm?" ("+tm.name+")":"")+" : "+((sl.type&&sl.type.name)||"indisponible");
  });
 }catch(e){absents=["Données indisponibles avec votre plan"]}
 const rr=(fx.referees||[]),main=rr.find(x=>x.type_id===6)||rr[0],rf=main&&main.referee;
 const arbitre={nom:rf?(rf.display_name||rf.name||rf.common_name):"Non désigné",moyenne:null};
 const lh=(fa.gf+fb.ga)/2||1,la=(fb.gf+fa.ga)/2||1;let best=[0,0,0];
 for(let i=0;i<6;i++)for(let j=0;j<6;j++){const p=pois(lh,i)*pois(la,j);if(p>best[2])best=[i,j,p]}
 const btts=Math.round((1-Math.exp(-lh))*(1-Math.exp(-la))*100);
 const hist=h2h.filter(m=>(m.scores||[]).length).sort((a,b)=>a.starting_at<b.starting_at?1:-1).slice(0,5).map(m=>{
  const [h,a]=goals(m),ph=m.participants.find(p=>p.meta.location==="home"),pa=m.participants.find(p=>p.meta.location==="away");
  return m.starting_at.slice(0,10)+" : "+ph.name+" "+h+"-"+a+" "+pa.name});
 return{confirme:true,match:{competition:fx.league&&fx.league.name,heure:utc(fx.starting_at).toISOString(),stade:fx.venue&&fx.venue.name},
  equipes:[{nom:A.name,...fa},{nom:B.name,...fb}],h2h:hist,absents,arbitre,
  pronostic:{score:best[0]+"-"+best[1],btts,cartons:+(fa.jaunes+fb.jaunes).toFixed(1)}}
}

module.exports=async(req,res)=>{
  try{
    if(!process.env.SPORTMONKS_TOKEN)return res.status(200).json({erreur:"Clé API manquante : ajoutez SPORTMONKS_TOKEN dans les variables d’environnement Vercel."});
    const {home,away}=req.query;
    if(!home||!away)return res.status(200).json({erreur:"Veuillez saisir les deux équipes."});
    res.status(200).json(await analyse(home,away));
  }catch(e){res.status(200).json({erreur:e.message||"Erreur inattendue du serveur."})}
};
