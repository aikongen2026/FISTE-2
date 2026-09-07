(function initFishingInsights(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.FishingInsights=api;
})(typeof globalThis!=='undefined'?globalThis:this,function fishingInsightsFactory(){
  const guides={
    sjoorret:{
      id:'sjoorret',name:'Sjøørret',season:'Ofte mest tilgjengelig fra land vår og høst, men lokale temperaturer og fredningsregler styrer.',
      habitat:'Søk grunne bukter, strømkanter, odder og overganger mellom sand, tang, stein og dypere vann.',
      presentation:'Varier tempo og legg inn korte spinnstopp. Start naturlig og fisk mer markert når vannet er farget eller lyset er svakt.',
      waterColumn:'Start høyt over grunt vann; søk deretter trinnvis ned mot overgangene.',
      caution:'Kontroller fredningssoner, minstemål og lokale bestemmelser før fiske.'
    },
    makrell:{
      id:'makrell',name:'Makrell',season:'Vanligst kystnært i den varme delen av året når byttefisken samler seg.',
      habitat:'Se etter strømkanter, odder, brygger og åpent vann med fugleaktivitet eller synlig småfisk.',
      presentation:'Bruk rask og jevn innsveiving med sluk, pilk eller liten opphenger. Stopp hvis fisken følger uten å ta.',
      waterColumn:'Søk aktivt fra overflaten og ned gjennom hele vannsøylen.',
      caution:'Unngå farlige svaberg og kontroller lokale adgangs- og fiskeregler.'
    },
    sei:{
      id:'sei',name:'Sei',season:'Kan treffes store deler av året; tilgjengeligheten fra land følger temperatur, strøm og byttefisk.',
      habitat:'Fokuser på bratte kanter, strømutsatte sund, dype kaier og områder der småfisk presses sammen.',
      presentation:'Fisk rytmisk med pilk, jigg eller kompakt sluk. Varier synkehøyde og tempo før du bytter plass.',
      waterColumn:'Start midt i vannet og arbeid trinnvis nedover uten å sette deg fast i bunnen.',
      caution:'Kontroller dybde, strøm, ferdsel og lokale regler.'
    },
    orret:{
      id:'orret',name:'Ørret i ferskvann',season:'Aktiviteten er ofte god når vannet er kjølig vår og høst; sommertid kan morgen og kveld være best.',
      habitat:'Søk innløp, utløp, marbakker, odder og grunne partier nær vegetasjon eller stein.',
      presentation:'Bruk små sluker, spinnere eller wobblere med kontrollert fart. Legg inn pauser og retningsendringer.',
      waterColumn:'Fisk grunt i kjølig vann; søk dypere og nær skygge når overflaten blir varm.',
      caution:'Fiskekort, sesong og minstemål varierer mellom vann og vassdrag.'
    },
    abbor:{
      id:'abbor',name:'Abbor',season:'Kan fiskes store deler av året; varmere perioder gir ofte mer aktivt søkefiske.',
      habitat:'Let ved vegetasjonskanter, brygger, stein, marbakker og småfiskstimer.',
      presentation:'Små jigger, spinnere og wobblere fungerer med korte rykk, stopp og tydelige fartsendringer.',
      waterColumn:'Start nær struktur og bunn, men test høyere dersom småfisken står pelagisk.',
      caution:'Vis hensyn ved gyteområder og kontroller lokale regler og fiskekort.'
    },
    gjedde:{
      id:'gjedde',name:'Gjedde',season:'Ofte mest aktiv i kjølig til moderat vann; varmt vann krever skånsom og rask håndtering.',
      habitat:'Søk sivkanter, vegetasjon, viker, marbakker og bakholdspunkter nær byttefisk.',
      presentation:'Bruk større skjesluker, wobblere eller shads med pauser. Tilpass krok og fortom for sikker landing.',
      waterColumn:'Fisk over og langs vegetasjonen; la agnet følge kanten uten å grave i bunnen.',
      caution:'Bruk egnet fortom, tang og avkrokingsutstyr; kontroller lokale regler.'
    }
  };

  function finiteAverage(values){
    const valid=values.filter(value=>value!==null&&value!==undefined&&value!=='').map(Number).filter(Number.isFinite);
    if(!valid.length) return null;
    return Math.round((valid.reduce((sum,value)=>sum+value,0)/valid.length)*10)/10;
  }

  function timeBand(date){
    const hour=date.getHours();
    if(hour>=5&&hour<=9) return {id:'morgen',label:'Morgen',range:'05–09'};
    if(hour>=10&&hour<=16) return {id:'dag',label:'Dag',range:'10–16'};
    if(hour>=17&&hour<=22) return {id:'kveld',label:'Kveld',range:'17–22'};
    return {id:'natt',label:'Natt',range:'23–04'};
  }

  function normalizeEntries(entries,fish){
    return (Array.isArray(entries)?entries:[]).filter(entry=>{
      if(!entry||typeof entry!=='object'||entry.fish!==fish) return false;
      const date=new Date(entry.time);
      return !Number.isNaN(date.getTime())&&(entry.result==='fangst'||entry.result==='ingen-fangst');
    }).map(entry=>({...entry,_date:new Date(entry.time)}));
  }

  function buildCatchInsights(entries,fish){
    const relevant=normalizeEntries(entries,fish);
    const caught=relevant.filter(entry=>entry.result==='fangst');
    const sessions=relevant.length;
    const catches=caught.length;
    const result={
      fish,sessions,catches,catchRate:sessions?Math.round(catches/sessions*100):0,
      confidence:sessions<3?'For lite data':sessions<10?'Tidlig mønster':'Personlig mønster',
      message:sessions<3?'Registrer minst tre turer for å se forsiktige mønstre.':'Mønstrene bygger bare på dine lokalt lagrede turer.',
      bestTime:null,topLure:null,caughtWeather:{wind:null,cloud:null,precipitation:null,temp:null,tempTrend:null}
    };
    if(sessions<3) return result;

    const bands=new Map();
    for(const entry of relevant){
      const band=timeBand(entry._date);
      const item=bands.get(band.id)||{...band,sessions:0,catches:0};
      item.sessions+=1;
      if(entry.result==='fangst') item.catches+=1;
      bands.set(band.id,item);
    }
    const eligible=[...bands.values()].filter(item=>item.sessions>=2&&item.catches>0).map(item=>({...item,rate:Math.round(item.catches/item.sessions*100)}));
    eligible.sort((a,b)=>b.rate-a.rate||b.catches-a.catches||b.sessions-a.sessions);
    result.bestTime=eligible[0]||null;

    const lureCounts=new Map();
    for(const entry of caught){
      const label=String(entry.lure||'').trim();
      if(!label) continue;
      const key=label.toLocaleLowerCase('no-NO');
      const current=lureCounts.get(key)||{label,count:0};
      current.count+=1;
      lureCounts.set(key,current);
    }
    const lures=[...lureCounts.values()].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'no'));
    result.topLure=lures[0]||null;
    result.caughtWeather={
      wind:finiteAverage(caught.map(entry=>entry.weather?.wind)),
      cloud:finiteAverage(caught.map(entry=>entry.weather?.cloud)),
      precipitation:finiteAverage(caught.map(entry=>entry.weather?.precipitation)),
      temp:finiteAverage(caught.map(entry=>entry.weather?.temp)),
      tempTrend:finiteAverage(caught.map(entry=>entry.weather?.tempTrend))
    };
    return result;
  }

  function getSpeciesGuide(fish){
    return guides[fish]||guides.sjoorret;
  }

  return {buildCatchInsights,getSpeciesGuide,timeBand};
});
