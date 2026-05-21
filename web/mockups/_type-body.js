// Shared dashboard markup for the typography mockups — injected into #app so
// each type page only needs to set the font.
document.getElementById('app').innerHTML = `
  <div class="phone">
    <div class="body">
      <div class="hello">Tuesday · Phase 1</div>
      <div class="h1">Ready to train 🏊</div>
      <div class="ring-card">
        <div class="ring"><span>5/6</span></div>
        <div class="rm">
          <div class="title">Phase 1 · Sprint Development</div>
          <div class="line">Block 5 of 6</div>
          <div class="gate"><span class="gd"></span>Best 25m: <b>16.2s</b> → 14.0s</div>
          <div class="gate"><span class="gd ok">✓</span>Avg SWOLF: <b>30</b> → 30</div>
        </div>
      </div>
      <div class="grid">
        <div class="tile"><div class="k">Best 25m</div><div class="v">16.2s</div><div class="d up">▼ 0.2 vs last</div>
          <svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="3,20 22,17 42,15 61,12 81,9 97,7" fill="none" stroke="#2ee6a6" stroke-width="2.5" stroke-linecap="round"/></svg></div>
        <div class="tile"><div class="k">Avg SWOLF</div><div class="v">30</div><div class="d up">▼ 1</div>
          <svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="3,6 22,9 42,11 61,13 81,16 97,19" fill="none" stroke="#2ee6a6" stroke-width="2.5" stroke-linecap="round"/></svg></div>
        <div class="tile"><div class="k">Dist / stroke</div><div class="v">3.6m</div><div class="d up">▲ 0.1</div>
          <svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="3,19 22,16 42,15 61,12 81,10 97,8" fill="none" stroke="#2ee6a6" stroke-width="2.5" stroke-linecap="round"/></svg></div>
        <div class="tile"><div class="k">Avg pace /100m</div><div class="v">1:28</div><div class="d up">▼ 2s</div>
          <svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="3,20 22,18 42,14 61,12 81,10 97,7" fill="none" stroke="#2ee6a6" stroke-width="2.5" stroke-linecap="round"/></svg></div>
      </div>
      <div class="sec">Next session</div>
      <div class="session">
        <div class="row"><strong>Sprint · Block 6 S1</strong><span class="tag">1,700m</span></div>
        <div class="mini">10×25 max · 6×50 race sim · cool-down</div>
        <div class="mini">🎯 beat 16.2s · SWOLF 23 · 7 strokes/length</div>
        <button class="btn">View &amp; log session</button>
      </div>
    </div>
    <nav class="nav">
      <a class="on"><span class="ic">▦</span>Today</a><a><span class="ic">✍︎</span>Log</a>
      <a><span class="ic">✦</span>Feedback</a><a><span class="ic">📈</span>Graphs</a>
      <a><span class="ic">≣</span>History</a><a><span class="ic">⚙︎</span>More</a>
    </nav>
  </div>`;
