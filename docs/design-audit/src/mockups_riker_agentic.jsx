// Riker agentic conversation — current vs redesign
// Real exchange: "show me my overdue jobs" → markdown table of 12 jobs + flags

function RikerAgenticCurrent() {
  return (
    <div style={{width:'100%', height:'100%', background:'#0F0F18', color:'#E8E8EE', fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      <div style={{padding:'12px 14px', borderBottom:'1px solid #22222C', display:'flex', alignItems:'center', gap:10}}>
        <div style={{width:28, height:28, borderRadius:'50%', background:'linear-gradient(135deg, #7c3aed, #E8601C)'}}></div>
        <div>
          <div style={{fontSize:12, fontWeight:700}}>Riker</div>
          <div style={{fontSize:9, color:'#9A9AA8'}}>AI Assistant</div>
        </div>
      </div>

      <div style={{flex:1, overflow:'hidden', padding:12, fontSize:10}}>
        <div style={{background:'#E8601C', color:'white', padding:'6px 10px', borderRadius:10, marginLeft:'auto', width:'fit-content', fontSize:11, marginBottom:10}}>
          show me my overdue jobs
        </div>
        <div style={{background:'#1A1A2A', padding:'8px 10px', borderRadius:10, marginBottom:8}}>
          Here are your 12 overdue jobs (oldest first):
        </div>

        {/* dumped markdown table rendered small */}
        <div style={{background:'#1A1A2A', padding:8, borderRadius:6, fontFamily:'JetBrains Mono, monospace', fontSize:7, lineHeight:1.3, overflow:'hidden'}}>
          <div style={{display:'grid', gridTemplateColumns:'14px 1fr 1fr 40px 40px 40px', gap:3, borderBottom:'1px solid #333', paddingBottom:3, marginBottom:3, fontWeight:700}}>
            <div>#</div><div>Job</div><div>Location</div><div>City</div><div>Scope</div><div>Due</div>
          </div>
          {[
            ['1','Wabi House','Sushi','Allen','Supp','Jan 3'],
            ['2','Loco Coyote','BBQ','Grapevine','Ext','Jan 8'],
            ['3','Cholita Roja','Mex','McKinney','Supp','Jan 15'],
            ['4','Amigos','Rest','Frisco','Ext','Jan 22'],
            ['5','Amigos','Rest','Frisco','Supp','Jan 22'],
            ['6','Taco Joe','QSR','Euless','Ext','Feb 1'],
            ['7','Blue Plate','Diner','Irving','Supp','Feb 5'],
          ].map((r,i)=>(
            <div key={i} style={{display:'grid', gridTemplateColumns:'14px 1fr 1fr 40px 40px 40px', gap:3, padding:'2px 0', borderBottom:'1px solid #22222C'}}>
              {r.map((c,j)=><div key={j}>{c}</div>)}
            </div>
          ))}
          <div style={{color:'#9A9AA8', paddingTop:4}}>...5 more</div>
        </div>

        <div style={{background:'#1A1A2A', padding:'8px 10px', borderRadius:10, marginTop:8, fontSize:10}}>
          <b>Flags:</b>
          <div style={{fontSize:9, marginTop:3, color:'#C8C8D4'}}>⚠ Wabi House Sushi needs Brycer filing<br/>⚠ Loco Coyote travel charge<br/>⚠ Cholita Roja customer resistant<br/>⚠ Amigos has 2 separate overdue jobs</div>
          <div style={{marginTop:6, fontSize:10}}>Want me to start rescheduling any of these?</div>
        </div>
      </div>

      <div style={{padding:'8px 10px', borderTop:'1px solid #22222C', display:'flex', alignItems:'center', gap:6}}>
        <div style={{flex:1, fontSize:10, color:'#6A6A78'}}>Ask anything...</div>
        <div style={{width:20, height:20, background:'#E8601C', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, color:'white'}}>↑</div>
      </div>
    </div>
  );
}

function RikerAgenticRedesign() {
  return (
    <div style={{width:'100%', height:'100%', background:'#0A0A10', color:'#E8E8EE', fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      <div style={{padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'center', gap:10}}>
        <div style={{width:26, height:26, borderRadius:3, background:'rgba(232,96,28,0.12)', border:'1px solid #E8601C', display:'flex', alignItems:'center', justifyContent:'center'}}>
          <div style={{width:7, height:7, background:'#E8601C', borderRadius:'50%'}}></div>
        </div>
        <div style={{flex:1}}>
          <div style={{fontSize:12, fontWeight:600}}>Riker</div>
          <div style={{fontSize:9.5, color:'#9A9AA8'}}>Reading your schedule, jobs, and client history</div>
        </div>
        <div style={{fontSize:11, color:'#9A9AA8'}}>Clear</div>
      </div>

      <div style={{flex:1, overflow:'hidden', padding:'12px 14px'}}>
        <div style={{background:'rgba(232,96,28,0.12)', color:'#E8E8EE', padding:'7px 11px', borderRadius:2, marginLeft:'auto', width:'fit-content', fontSize:11.5, marginBottom:14, border:'1px solid rgba(232,96,28,0.3)'}}>
          show me my overdue jobs
        </div>

        <div style={{fontSize:11, color:'#9A9AA8', marginBottom:8, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.06em'}}>12 OVERDUE · OLDEST FIRST</div>

        {/* Structured job cards instead of dumped table */}
        <div style={{display:'flex', flexDirection:'column', gap:5}}>
          {[
            ['Wabi House Sushi','Allen','SUPP',105,'Brycer'],
            ['Loco Coyote','Grapevine','EXT',100,'Travel'],
            ['Cholita Roja','McKinney','SUPP',93,'Resistant'],
            ['Amigos','Frisco','EXT',86,null],
            ['Amigos','Frisco','SUPP',86,null],
          ].map((r,i)=>(
            <div key={i} style={{background:'#15151E', border:'1px solid #22222C', padding:'8px 10px', borderRadius:2, display:'grid', gridTemplateColumns:'1fr 50px 42px', gap:6, alignItems:'center'}}>
              <div>
                <div style={{fontSize:11.5, fontWeight:500}}>{r[0]}</div>
                <div style={{fontSize:10, color:'#9A9AA8'}}>{r[1]} · {r[4] && <span style={{color:'#FFB066'}}>⚑ {r[4]}</span>}</div>
              </div>
              <div style={{fontSize:9, fontFamily:'JetBrains Mono, monospace', padding:'2px 5px', borderRadius:2, background:'#22222C', textAlign:'center', letterSpacing:'0.06em'}}>{r[2]}</div>
              <div style={{fontSize:10, color:'#FF8A8A', textAlign:'right', fontFamily:'JetBrains Mono, monospace'}}>{r[3]}d</div>
            </div>
          ))}
          <div style={{fontSize:10, color:'#9A9AA8', padding:'4px 2px'}}>+ 7 more</div>
        </div>

        {/* Action suggestions */}
        <div style={{marginTop:12, padding:'10px 12px', background:'rgba(232,96,28,0.06)', border:'1px solid rgba(232,96,28,0.25)', borderRadius:2}}>
          <div style={{fontSize:11, color:'#E8E8EE', marginBottom:8}}>I can reschedule these. Which batch?</div>
          <div style={{display:'flex', flexDirection:'column', gap:5}}>
            {['Batch all 12 into next available slots','Start with the 4 flagged ones','Just Wabi House (oldest)'].map((t,i)=>(
              <div key={i} style={{background:'#1A1A24', border:'1px solid #22222C', padding:'7px 10px', borderRadius:2, fontSize:11, display:'flex', justifyContent:'space-between'}}>
                <span>{t}</span><span style={{color:'#9A9AA8'}}>→</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{padding:'10px 14px', borderTop:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'center', gap:8}}>
        <div style={{flex:1, fontSize:11, color:'#6A6A78'}}>Or ask something else…</div>
        <div style={{width:22, height:22, background:'#E8601C', borderRadius:2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:'white', fontWeight:700}}>→</div>
      </div>
    </div>
  );
}

window.RikerAgenticCurrent = RikerAgenticCurrent;
window.RikerAgenticRedesign = RikerAgenticRedesign;
