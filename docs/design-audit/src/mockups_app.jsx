// Field app — current state + redesign

const APP_ORANGE = '#E8601C';
const APP_DARK = '#14141E';
const APP_DARK_2 = '#1A1A2A';
const APP_DARK_3 = '#232334';
const APP_TEXT = '#E8E8EE';
const APP_MUTED = '#9A9AA8';

// — shared status bar —
function StatusBar({ time='9:41', dark=true }) {
  return (
    <div style={{
      display:'flex', justifyContent:'space-between', alignItems:'center',
      padding:'14px 24px 6px', fontSize:12, fontWeight:600,
      color: dark ? APP_TEXT : '#111'
    }}>
      <span>{time}</span>
      <span style={{display:'flex', gap:4, alignItems:'center'}}>
        <span style={{fontSize:10}}>●●●●</span>
        <span style={{fontSize:10}}>📶</span>
        <span style={{fontSize:10}}>🔋</span>
      </span>
    </div>
  );
}

// ——— CURRENT HOME ———
function AppHomeCurrent() {
  const weeks = [
    [30,31,1,2,3,4,5],
    [6,7,8,9,10,11,12],
    [13,14,15,16,17,18,19],
    [20,21,22,23,24,25,26],
    [27,28,29,30,1,2,3],
  ];
  const dots = {3:2,7:1,9:3,12:1,14:2,18:1,21:4,23:1,25:2};
  return (
    <div style={{width:'100%', height:'100%', background:APP_DARK, color:APP_TEXT, fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      <StatusBar/>
      <div style={{padding:'4px 16px 8px', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <div style={{fontSize:18, fontWeight:700}}>Hey, Jon 👋</div>
        <div style={{width:32, height:32, borderRadius:'50%', background:APP_DARK_3, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12}}>J</div>
      </div>

      {/* Today's route banner */}
      <div style={{margin:'0 16px 10px', background:APP_ORANGE, padding:'10px 12px', borderRadius:6, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <div>
          <div style={{fontSize:12, fontWeight:700}}>Today's Route Ready</div>
          <div style={{fontSize:10, opacity:0.9}}>7 stops · 62 miles</div>
        </div>
        <div style={{fontSize:11, fontWeight:600}}>START →</div>
      </div>

      {/* Quick actions row */}
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, padding:'0 16px 10px'}}>
        {['Route','Truck','To-Do'].map(t=>(
          <div key={t} style={{background:APP_DARK_2, padding:10, borderRadius:6, textAlign:'center'}}>
            <div style={{width:22, height:22, background:APP_DARK_3, margin:'0 auto 6px', borderRadius:4}}></div>
            <div style={{fontSize:10, fontWeight:600}}>{t}</div>
          </div>
        ))}
      </div>

      {/* Overdue alert */}
      <div style={{margin:'0 16px 10px', background:'#4a1f1f', border:'1px solid #7a2e2e', padding:'8px 10px', borderRadius:6, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <div style={{fontSize:11, fontWeight:600, color:'#ff7a7a'}}>⚠ 12 Overdue Jobs</div>
        <div style={{fontSize:10, color:'#ff7a7a'}}>VIEW →</div>
      </div>

      {/* Calendar */}
      <div style={{margin:'0 16px', background:APP_DARK_2, padding:10, borderRadius:6, flex:1}}>
        <div style={{display:'flex', justifyContent:'space-between', marginBottom:6, alignItems:'center'}}>
          <div style={{fontSize:11, fontWeight:600}}>April 2026</div>
          <div style={{fontSize:11, color:APP_MUTED}}>◀ ▶</div>
        </div>
        <div style={{display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2, fontSize:8.5, color:APP_MUTED, marginBottom:3, textAlign:'center'}}>
          {['S','M','T','W','T','F','S'].map((d,i)=><div key={i}>{d}</div>)}
        </div>
        {weeks.map((wk,r)=>(
          <div key={r} style={{display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2, marginBottom:2}}>
            {wk.map((d,i)=>{
              const inMonth = !(r===0 && d>7) && !(r===4 && d<7);
              return (
                <div key={i} style={{aspectRatio:'1', background: d===17 ? APP_ORANGE : 'transparent', borderRadius:4, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontSize:10, color: !inMonth ? '#444' : APP_TEXT, position:'relative'}}>
                  <div>{d}</div>
                  {dots[d] && inMonth && (
                    <div style={{display:'flex', gap:1, marginTop:1}}>
                      {Array.from({length:Math.min(dots[d],3)}).map((_,k)=>(
                        <div key={k} style={{width:3, height:3, borderRadius:'50%', background:APP_ORANGE}}></div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Bottom nav */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(5,1fr)', padding:'8px 4px 14px', borderTop:'1px solid #2a2a38', background:APP_DARK_2}}>
        {[['📅','Cal'],['🔨','Jobs'],['🏢','Clients'],['$','Money'],['👷','Techs']].map(([i,l],k)=>(
          <div key={k} style={{textAlign:'center', color: k===0 ? APP_ORANGE : APP_MUTED}}>
            <div style={{fontSize:14}}>{i}</div>
            <div style={{fontSize:9, marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ——— REDESIGN HOME ———
function AppHomeRedesign() {
  return (
    <div style={{width:'100%', height:'100%', background:'#0A0A10', color:APP_TEXT, fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      <StatusBar/>
      <div style={{padding:'8px 20px 14px'}}>
        <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:APP_MUTED, letterSpacing:'0.12em'}}>FRIDAY · APR 17</div>
        <div style={{fontFamily:'Fraunces, serif', fontSize:26, fontWeight:500, letterSpacing:'-0.02em', marginTop:2}}>Morning, Jon.</div>
      </div>

      {/* Today card — primary focus, big, tappable */}
      <div style={{margin:'0 16px 12px', background:APP_ORANGE, padding:'16px 18px', borderRadius:4, position:'relative', overflow:'hidden'}}>
        <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, letterSpacing:'0.1em', opacity:0.85}}>TODAY · 7 STOPS · 62 MI</div>
        <div style={{fontSize:22, fontWeight:600, marginTop:8, lineHeight:1.15}}>Ready when you are.</div>
        <div style={{fontSize:12.5, marginTop:4, opacity:0.92}}>First stop: <b>Torchy's Tacos</b>, Bedford · 8:30 AM</div>
        <div style={{marginTop:14, display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div style={{background:'rgba(0,0,0,0.25)', padding:'9px 14px', borderRadius:2, fontSize:12, fontWeight:600, letterSpacing:'0.02em'}}>NAVIGATE TO FIRST STOP →</div>
          <div style={{fontSize:11, opacity:0.8}}>See all</div>
        </div>
      </div>

      {/* Secondary bar — low priority, small */}
      <div style={{margin:'0 16px 14px', display:'flex', gap:8}}>
        <div style={{flex:1, background:'#15151E', border:'1px solid #22222C', padding:'10px 12px', borderRadius:4}}>
          <div style={{fontSize:10, color:APP_MUTED, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.08em'}}>TRUCK</div>
          <div style={{fontSize:13, fontWeight:500, marginTop:2}}>Stocked · 2 refills due</div>
        </div>
        <div style={{flex:1, background:'#15151E', border:'1px solid #22222C', padding:'10px 12px', borderRadius:4}}>
          <div style={{fontSize:10, color:APP_MUTED, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.08em'}}>TO-DO</div>
          <div style={{fontSize:13, fontWeight:500, marginTop:2}}>3 invoices to send</div>
        </div>
      </div>

      {/* Overdue — quieter, actionable */}
      <div style={{margin:'0 16px 14px', padding:'12px 14px', background:'#15151E', border:'1px solid #22222C', borderLeft:'3px solid #CC7B33', borderRadius:2, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <div>
          <div style={{fontSize:12.5, fontWeight:600}}>12 jobs past due</div>
          <div style={{fontSize:11, color:APP_MUTED, marginTop:2}}>Oldest: Whataburger #47, 23 days</div>
        </div>
        <div style={{fontSize:11, color:APP_ORANGE, fontWeight:600, letterSpacing:'0.04em'}}>REVIEW →</div>
      </div>

      {/* Week view instead of month calendar */}
      <div style={{margin:'0 16px', flex:1, overflow:'hidden'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10}}>
          <div style={{fontFamily:'Fraunces, serif', fontSize:15, fontWeight:500}}>This week</div>
          <div style={{fontSize:10, color:APP_MUTED, fontFamily:'JetBrains Mono, monospace'}}>APR 13 – 19 · 34 JOBS</div>
        </div>
        <div style={{display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:5}}>
          {[
            ['M',13,5], ['T',14,6], ['W',15,4], ['T',16,3],
            ['F',17,7,true], ['S',18,0], ['S',19,0]
          ].map(([d,n,count,today],i)=>(
            <div key={i} style={{
              background: today ? APP_ORANGE : '#15151E',
              border: today ? 'none' : '1px solid #22222C',
              padding:'10px 6px', borderRadius:3, textAlign:'center',
              color: today ? 'white' : APP_TEXT
            }}>
              <div style={{fontSize:9, opacity:0.7, fontFamily:'JetBrains Mono, monospace'}}>{d}</div>
              <div style={{fontSize:16, fontWeight:600, marginTop:2}}>{n}</div>
              <div style={{fontSize:9.5, marginTop:4, opacity: count ? 0.9 : 0.4}}>{count || '—'}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom nav — clearer, bigger */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(5,1fr)', padding:'10px 8px 18px', borderTop:'1px solid #1a1a24', background:'#0A0A10'}}>
        {[['Today',true],['Jobs'],['Clients'],['Money'],['Crew']].map(([l,on],k)=>(
          <div key={k} style={{textAlign:'center', color: on ? APP_ORANGE : APP_MUTED, position:'relative'}}>
            <div style={{width:22, height:22, margin:'0 auto 3px', borderRadius:4, background: on ? 'rgba(232,96,28,0.12)' : 'transparent', border: `1px solid ${on ? APP_ORANGE : '#2a2a38'}`}}></div>
            <div style={{fontSize:10, fontWeight: on ? 600 : 500, letterSpacing:'0.02em'}}>{l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ——— JOB DETAIL CURRENT ———
function JobDetailCurrent() {
  return (
    <div style={{width:'100%', height:'100%', background:APP_DARK, color:APP_TEXT, fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      <StatusBar/>
      <div style={{padding:'8px 12px 10px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid #2a2a38'}}>
        <div style={{fontSize:14}}>‹</div>
        <div style={{flex:1}}>
          <div style={{fontSize:13, fontWeight:700}}>Job #A-2041</div>
          <div style={{fontSize:9, color:APP_MUTED}}>Apr 17 · Scheduled</div>
        </div>
        <div style={{background:APP_ORANGE, color:'white', padding:'3px 7px', borderRadius:3, fontSize:9, fontWeight:700}}>JON</div>
      </div>

      <div style={{padding:'10px 12px', borderBottom:'1px solid #2a2a38'}}>
        <div style={{fontSize:11, fontWeight:600}}>Torchy's Tacos — Bedford</div>
        <div style={{fontSize:10, color:APP_MUTED, marginTop:2}}>1500 Airport Fwy, Bedford TX</div>
        <div style={{marginTop:6, display:'inline-block', background:APP_DARK_3, padding:'4px 8px', borderRadius:3, fontSize:9, fontWeight:600}}>📍 Navigate</div>
      </div>

      <div style={{padding:'10px 12px', borderBottom:'1px solid #2a2a38'}}>
        <div style={{fontSize:10, color:APP_MUTED, marginBottom:6}}>WORK ORDER</div>
        <div style={{background:APP_DARK_2, border:'1px solid #2a2a38', padding:'6px 8px', borderRadius:4, fontSize:10, display:'flex', justifyContent:'space-between'}}>
          <span>+ Quick Add ▾</span>
        </div>
        <div style={{marginTop:8}}>
          {[
            ['1','Annual Suppression Inspection','275','275'],
            ['2','10lb ABC Extinguisher Recharge','28','56'],
            ['1','Fusible Link Replacement','18','18'],
          ].map((row,i)=>(
            <div key={i} style={{display:'grid', gridTemplateColumns:'24px 1fr 42px 42px', gap:6, fontSize:9.5, padding:'5px 0', borderBottom:'1px solid #222230'}}>
              <div>{row[0]}</div>
              <div>{row[1]}</div>
              <div style={{textAlign:'right'}}>${row[2]}</div>
              <div style={{textAlign:'right'}}>${row[3]}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{padding:'10px 12px', borderBottom:'1px solid #2a2a38'}}>
        <div style={{fontSize:10, color:APP_MUTED, marginBottom:5}}>TECH NOTES</div>
        <div style={{background:APP_DARK_2, border:'1px solid #2a2a38', padding:8, borderRadius:4, fontSize:10, color:APP_MUTED, height:32}}>Add notes...</div>
        <div style={{marginTop:6, fontSize:10, color:APP_ORANGE}}>+ Add Photo</div>
      </div>

      <div style={{padding:'10px 12px', display:'flex', gap:10, alignItems:'center'}}>
        <div style={{display:'flex', alignItems:'center', gap:6, fontSize:10}}>
          <div style={{width:26, height:14, background:APP_ORANGE, borderRadius:8, position:'relative'}}><div style={{position:'absolute', right:1, top:1, width:12, height:12, background:'white', borderRadius:'50%'}}></div></div>
          Build Invoice
        </div>
        <div style={{display:'flex', alignItems:'center', gap:4, fontSize:10}}>
          <div style={{width:11, height:11, border:'1px solid '+APP_MUTED, borderRadius:2}}></div>
          Prompt-Pay
        </div>
      </div>

      <div style={{marginTop:'auto', padding:12}}>
        <div style={{background:APP_ORANGE, color:'white', padding:'11px', textAlign:'center', fontSize:11, fontWeight:700, borderRadius:4}}>Complete Job · Generate Invoice</div>
      </div>
    </div>
  );
}

// ——— JOB DETAIL REDESIGN ———
function JobDetailRedesign() {
  return (
    <div style={{width:'100%', height:'100%', background:'#0A0A10', color:APP_TEXT, fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      <StatusBar/>
      {/* top */}
      <div style={{padding:'8px 18px 14px'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
          <div style={{fontSize:18, color:APP_MUTED}}>‹ All jobs</div>
          <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:APP_MUTED}}>#A-2041</div>
        </div>
        <div style={{fontFamily:'Fraunces, serif', fontSize:22, fontWeight:500, letterSpacing:'-0.015em', lineHeight:1.1}}>Torchy's Tacos</div>
        <div style={{fontSize:12, color:APP_MUTED, marginTop:3}}>Bedford · 1500 Airport Fwy</div>
        <div style={{display:'flex', gap:8, marginTop:10}}>
          <div style={{flex:1, background:APP_DARK_3, padding:'9px 12px', borderRadius:2, fontSize:11.5, fontWeight:500, textAlign:'center'}}>↗ Navigate</div>
          <div style={{flex:1, background:APP_DARK_3, padding:'9px 12px', borderRadius:2, fontSize:11.5, fontWeight:500, textAlign:'center'}}>📞 Call site</div>
        </div>
      </div>

      {/* service tags row */}
      <div style={{padding:'0 18px 12px', display:'flex', gap:6, flexWrap:'wrap'}}>
        <div style={{fontSize:10, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.08em', padding:'4px 8px', borderRadius:2, background:'rgba(232,96,28,0.12)', color:APP_ORANGE, border:`1px solid ${APP_ORANGE}`}}>SUPPRESSION</div>
        <div style={{fontSize:10, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.08em', padding:'4px 8px', borderRadius:2, background:'#15151E', color:APP_MUTED, border:'1px solid #22222C'}}>EXT · 2</div>
        <div style={{fontSize:10, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.08em', padding:'4px 8px', borderRadius:2, background:'#15151E', color:APP_MUTED, border:'1px solid #22222C'}}>ANNUAL</div>
      </div>

      {/* work order — cleaner line items */}
      <div style={{margin:'0 18px', borderTop:'1px solid #1f1f29', paddingTop:12}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:8}}>
          <div style={{fontFamily:'Fraunces, serif', fontSize:14, fontWeight:500}}>Work order</div>
          <div style={{fontSize:10, color:APP_ORANGE, fontWeight:600, letterSpacing:'0.06em'}}>+ ADD ITEM</div>
        </div>
        {[
          ['Annual Suppression Inspection','1','$275'],
          ['10lb ABC Recharge','2','$56'],
          ['Fusible Link Replacement','1','$18'],
        ].map((row,i)=>(
          <div key={i} style={{display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1a1a24', fontSize:12.5}}>
            <div style={{flex:1}}>{row[0]}</div>
            <div style={{color:APP_MUTED, marginRight:12}}>×{row[1]}</div>
            <div style={{fontWeight:500}}>{row[2]}</div>
          </div>
        ))}
        <div style={{display:'flex', justifyContent:'space-between', padding:'10px 0 0', fontSize:13, fontWeight:600}}>
          <div>Subtotal</div>
          <div style={{fontFamily:'Fraunces, serif', fontSize:18}}>$349.00</div>
        </div>
      </div>

      {/* notes + photos as single strip */}
      <div style={{margin:'14px 18px 0', background:'#15151E', border:'1px solid #22222C', borderRadius:3, padding:'12px 14px'}}>
        <div style={{fontSize:11, color:APP_MUTED, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.08em', marginBottom:8}}>TECH NOTES</div>
        <div style={{fontSize:12, color:APP_MUTED, lineHeight:1.5}}>Tap to add notes or attach photos of the panel, tags, and any repairs needed.</div>
        <div style={{display:'flex', gap:6, marginTop:10}}>
          <div style={{fontSize:10.5, padding:'5px 10px', borderRadius:2, background:APP_DARK_3, fontWeight:500}}>📷 Photo</div>
          <div style={{fontSize:10.5, padding:'5px 10px', borderRadius:2, background:APP_DARK_3, fontWeight:500}}>🎤 Voice</div>
          <div style={{fontSize:10.5, padding:'5px 10px', borderRadius:2, background:APP_DARK_3, fontWeight:500}}>✏︎ Type</div>
        </div>
      </div>

      {/* Invoice block — clear, inline summary */}
      <div style={{margin:'14px 18px 0', background:'rgba(232,96,28,0.06)', border:'1px solid rgba(232,96,28,0.25)', borderRadius:3, padding:'12px 14px'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6}}>
          <div style={{fontSize:12, fontWeight:600}}>Invoice this job on complete</div>
          <div style={{width:34, height:18, background:APP_ORANGE, borderRadius:10, position:'relative'}}>
            <div style={{position:'absolute', right:2, top:2, width:14, height:14, background:'white', borderRadius:'50%'}}></div>
          </div>
        </div>
        <div style={{fontSize:11, color:APP_MUTED, lineHeight:1.5}}>Email invoice to <b style={{color:APP_TEXT}}>billing@torchys.com</b>. Include 2% prompt-pay discount if paid within 7 days.</div>
      </div>

      {/* Primary action */}
      <div style={{marginTop:'auto', padding:'14px 18px 18px', background:'linear-gradient(to top, #0A0A10 60%, transparent)'}}>
        <div style={{background:APP_ORANGE, color:'white', padding:'14px', textAlign:'center', fontSize:13.5, fontWeight:600, borderRadius:3, letterSpacing:'0.01em'}}>
          Complete job · Send $349 invoice
        </div>
      </div>
    </div>
  );
}

window.AppHomeCurrent = AppHomeCurrent;
window.AppHomeRedesign = AppHomeRedesign;
window.JobDetailCurrent = JobDetailCurrent;
window.JobDetailRedesign = JobDetailRedesign;
