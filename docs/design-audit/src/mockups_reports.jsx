// Reports view — current + redesign
// Based on real screenshot: orange hero KPI card, dense row-based sections

function ReportsCurrent() {
  return (
    <div style={{width:'100%', height:'100%', background:'#14141E', color:'#E8E8EE', fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      {/* top bar */}
      <div style={{display:'flex', alignItems:'center', gap:10, padding:'14px 14px 4px', fontSize:12}}>
        <span style={{fontSize:14, color:'#E8E8EE'}}>‹</span>
        <span style={{fontWeight:700, fontSize:14}}>Business Reports</span>
      </div>

      {/* orange hero KPI card */}
      <div style={{margin:'10px 12px', background:'#E8601C', borderRadius:6, padding:'14px 14px'}}>
        <div style={{fontSize:13, fontWeight:700, color:'white'}}>Stephens Advanced LLC</div>
        <div style={{fontSize:10, color:'rgba(255,255,255,0.85)', marginBottom:10}}>Fire Suppression & Safety · DFW Texas</div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:6}}>
          {[['$25,010.81','TOTAL REVENUE'],['$7,090.12','OUTSTANDING'],['1000','TOTAL JOBS'],['$29.77','AVG JOB VALUE']].map(([v,l],i)=>(
            <div key={i} style={{background:'rgba(0,0,0,0.18)', padding:'7px 8px', borderRadius:3}}>
              <div style={{fontSize:13, fontWeight:700, color:'white'}}>{v}</div>
              <div style={{fontSize:8, color:'rgba(255,255,255,0.85)'}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Business snapshot - dense rows */}
      <div style={{margin:'4px 12px 6px', background:'#1A1A2A', border:'1px solid #2a2a38', borderRadius:4, padding:10}}>
        <div style={{fontSize:10, color:'#9A9AA8', fontWeight:700, marginBottom:6}}>BUSINESS SNAPSHOT</div>
        {[
          ['Active Clients (12mo)','62'],
          ['Total Clients','328'],
          ['Completed Jobs','840'],
          ['Completion Rate','84%'],
          ['Extinguishers Managed','28'],
          ['Suppression Systems','23'],
          ['E-Light Fixtures','0'],
          ['Brycer Locations','7'],
        ].map(([l,v],i)=>(
          <div key={i} style={{display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:10, borderBottom: i<7 ? '1px solid #222230' : 'none'}}>
            <span style={{color:'#9A9AA8'}}>{l}</span><span style={{fontWeight:600}}>{v}</span>
          </div>
        ))}
      </div>

      {/* AR aging - dense rows */}
      <div style={{margin:'0 12px 8px', background:'#1A1A2A', border:'1px solid #2a2a38', borderRadius:4, padding:10}}>
        <div style={{fontSize:10, color:'#9A9AA8', fontWeight:700, marginBottom:6}}>ACCOUNTS RECEIVABLE AGING</div>
        {[
          ['Current (0-30 days)','$0.00'],
          ['31-60 days','$0.00'],
          ['61-90 days','$0.00'],
          ['90+ days','$7,090.12'],
          ['Total Outstanding','$7,090.12'],
        ].map(([l,v],i)=>(
          <div key={i} style={{display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:10, borderBottom: i<4 ? '1px solid #222230' : 'none', fontWeight: i===4 ? 700 : 400}}>
            <span style={{color: i===4 ? '#E8E8EE' : '#9A9AA8'}}>{l}</span><span>{v}</span>
          </div>
        ))}
      </div>

      <div style={{padding:'0 12px 10px', fontSize:10, color:'#9A9AA8', fontStyle:'italic'}}>…scrolls to weekly + monthly breakdowns</div>
    </div>
  );
}

function ReportsRedesign() {
  return (
    <div style={{width:'100%', height:'100%', background:'#0A0A10', color:'#E8E8EE', fontFamily:'Inter, sans-serif', overflow:'hidden', display:'flex', flexDirection:'column'}}>
      <div style={{padding:'12px 18px 8px', display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <span style={{fontSize:16, color:'#9A9AA8'}}>‹</span>
          <span style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:'#9A9AA8', letterSpacing:'0.12em'}}>REPORTS · APR 2026</span>
        </div>
        <div style={{fontSize:10, color:'#9A9AA8'}}>Export ↓</div>
      </div>

      {/* Hero - no more orange block; typographic */}
      <div style={{padding:'6px 18px 14px'}}>
        <div style={{fontFamily:'Fraunces, serif', fontSize:24, fontWeight:500, letterSpacing:'-0.02em', lineHeight:1.1}}>The business,<br/>year-to-date.</div>
      </div>

      {/* KPI grid with sparkline hints */}
      <div style={{margin:'0 12px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:6}}>
        {[
          ['$25,011','TOTAL REVENUE','+14% vs prior YTD','up'],
          ['$7,090','OUTSTANDING','⚠ 100% > 90 days','alert'],
          ['1,000','TOTAL JOBS','Lifetime','neutral'],
          ['$29.77','AVG JOB VALUE','−$2.10 vs Q4','down'],
        ].map(([v,l,trend,kind],i)=>(
          <div key={i} style={{background:'#15151E', border:'1px solid #22222C', padding:'11px 12px', borderRadius:3, borderLeft: kind==='alert' ? '3px solid #CC4B4B' : '1px solid #22222C'}}>
            <div style={{fontSize:9.5, color:'#9A9AA8', fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.08em', marginBottom:4}}>{l}</div>
            <div style={{fontFamily:'Fraunces, serif', fontSize:20, fontWeight:500, letterSpacing:'-0.015em'}}>{v}</div>
            <div style={{fontSize:9, color: kind==='alert' ? '#FF8A8A' : kind==='up' ? '#6EE7A1' : kind==='down' ? '#FFB066' : '#9A9AA8', marginTop:3}}>{trend}</div>
          </div>
        ))}
      </div>

      {/* AR aging - real horizontal bar */}
      <div style={{margin:'12px 12px 0', background:'#15151E', border:'1px solid #22222C', borderRadius:3, padding:'12px 14px'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:8}}>
          <div style={{fontFamily:'Fraunces, serif', fontSize:13, fontWeight:500}}>Receivables aging</div>
          <div style={{fontSize:10, color:'#FF8A8A', fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.06em'}}>100% IN 90+ BUCKET</div>
        </div>
        <div style={{display:'flex', height:28, borderRadius:2, overflow:'hidden', border:'1px solid #22222C', marginBottom:6}}>
          <div style={{flex:0.01, background:'#1f1f29'}}></div>
          <div style={{flex:0.01, background:'#1f1f29'}}></div>
          <div style={{flex:0.01, background:'#1f1f29'}}></div>
          <div style={{flex:1, background:'#CC4B4B', display:'flex', alignItems:'center', paddingLeft:10, fontSize:10, fontWeight:600, color:'white'}}>$7,090 · 90+ days</div>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:9, color:'#9A9AA8', fontFamily:'JetBrains Mono, monospace'}}>
          <span>0-30</span><span>31-60</span><span>61-90</span><span>90+</span>
        </div>
        <div style={{marginTop:10, padding:'8px 10px', background:'rgba(204,75,75,0.08)', border:'1px solid rgba(204,75,75,0.3)', borderRadius:2, fontSize:11, color:'#FFB0B0', lineHeight:1.4}}>
          <b>Anomaly.</b> Every outstanding dollar is 90+ days old. Review collection process.
        </div>
      </div>

      {/* Monthly */}
      <div style={{margin:'10px 12px 0', background:'#15151E', border:'1px solid #22222C', borderRadius:3, padding:'12px 14px', flex:1}}>
        <div style={{fontFamily:'Fraunces, serif', fontSize:13, fontWeight:500, marginBottom:8}}>Monthly — 2026</div>
        {[
          ['APR',23,11171,5971,0.53],
          ['MAR',7,16147,12294,0.76],
          ['FEB',1,946,946,1.0],
        ].map(([m,jobs,billed,collected,coll],i)=>(
          <div key={i} style={{padding:'6px 0', borderBottom: i<2 ? '1px solid #22222C' : 'none'}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3}}>
              <span><b style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, marginRight:8}}>{m}</b>{jobs} jobs</span>
              <span style={{color:'#9A9AA8'}}>${(billed/1000).toFixed(1)}k billed · ${(collected/1000).toFixed(1)}k collected</span>
            </div>
            <div style={{height:4, borderRadius:2, background:'#22222C', overflow:'hidden'}}>
              <div style={{width:`${coll*100}%`, height:'100%', background: coll>0.8 ? '#6EE7A1' : coll>0.6 ? '#E8601C' : '#CC4B4B'}}></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

window.ReportsCurrent = ReportsCurrent;
window.ReportsRedesign = ReportsRedesign;
