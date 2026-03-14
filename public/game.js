/**
 * Italy Card Game — Client
 * Handles all Socket.IO communication, UI rendering, drag-and-drop, sounds, animations
 */

// ────────────────────────────────────────────
//  SOCKET
// ────────────────────────────────────────────
const socket = io();

// ────────────────────────────────────────────
//  GAME STATE
// ────────────────────────────────────────────
let myPosition    = -1;
let myHand        = [];
let validCardIds  = [];
let isMyTurn      = false;
let currentBid    = 0;
let currentBidder = -1;
let trumpSuit     = null;
let trumpRevealed = false;
let leadSuit      = null;
let scores        = { A:0, B:0 };
let currentPlayer = -1;
let roundNumber   = 1;
let matchTarget   = 30;
let players       = [];
let bidLog        = [];
let powerCardSuit = null;
let trickCards    = {};
let handCounts    = { 0:0, 1:0, 2:0, 3:0 };
let dragCardId    = null;
let selectedTarget = 30;

// ────────────────────────────────────────────
//  AUDIO  (Web Audio API – simple synth tones)
// ────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, dur = 0.12, type = 'sine', vol = 0.18) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch(e) {}
}
function sfxCardPlay()    { playTone(440, 0.08, 'square',   0.12); }
function sfxDeal()        { playTone(660, 0.06, 'sine',     0.10); }
function sfxTrickWin()    {
  playTone(523, 0.15, 'sine', 0.15);
  setTimeout(() => playTone(659, 0.15, 'sine', 0.12), 120);
}
function sfxBid()         { playTone(392, 0.10, 'triangle', 0.15); }
function sfxError()       { playTone(200, 0.15, 'sawtooth', 0.12); }
function sfxTrumpReveal() {
  playTone(784, 0.20, 'sine', 0.18);
  setTimeout(() => playTone(1047, 0.25, 'sine', 0.15), 200);
}
function sfxGameWin() {
  [523, 659, 784, 1047].forEach((f, i) =>
    setTimeout(() => playTone(f, 0.20, 'sine', 0.15), i * 150));
}

// ────────────────────────────────────────────
//  CONSTANTS & HELPERS
// ────────────────────────────────────────────
const SUIT_SYM   = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };
const SUIT_COLOR = { spades:'black', hearts:'red', diamonds:'red', clubs:'black' };

function teamOf(pos) { return pos % 2 === 0 ? 'A' : 'B'; }

/** Translate server seat to visual slot relative to my seat */
function slot(serverPos) {
  const rel = ((serverPos - myPosition) + 4) % 4;
  return ['bottom', 'right', 'top', 'left'][rel];
}

function $(id) { return document.getElementById(id); }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(name).classList.add('active');
}

function showOverlay(id)   { $(id).classList.add('open');    }
function hideOverlay(id)   { $(id).classList.remove('open'); }
function hideAllOverlays() {
  document.querySelectorAll('.overlay').forEach(o => o.classList.remove('open'));
}

function toast(msg, duration = 2800) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration + 300);
}

function setTurnIndicator(serverPos) {
  ['top','bottom','left','right'].forEach(s => {
    const el = $(`turn-${s}`);
    if (el) el.style.display = 'none';
  });
  if (serverPos < 0) return;
  const s   = slot(serverPos);
  const el  = $(`turn-${s}`);
  if (el) el.style.display = 'block';
}

function updateOppCards(visualSlot, count) {
  const el = $(`opp-cards-${visualSlot}`);
  if (!el) return;
  el.innerHTML = '';
  const shown = Math.min(count, 13);
  for (let i = 0; i < shown; i++) {
    const d = document.createElement('div');
    d.className = 'card-back-sm';
    el.appendChild(d);
  }
}

// ────────────────────────────────────────────
//  CARD RENDERING
// ────────────────────────────────────────────
function buildCard(card, extraClass = '') {
  const div = document.createElement('div');
  div.className = `card ${SUIT_COLOR[card.suit]} ${extraClass}`;
  div.dataset.cardId = card.id;
  div.innerHTML = `
    <span class="card-rank-tl">${card.rank}</span>
    <span class="card-suit-tl">${SUIT_SYM[card.suit]}</span>
    <span class="card-suit-center">${SUIT_SYM[card.suit]}</span>
    <span class="card-rank-br">${card.rank}</span>
    <span class="card-suit-br">${SUIT_SYM[card.suit]}</span>`;
  return div;
}

function buildCardBack(extraClass = '') {
  const div = document.createElement('div');
  div.className = `card back ${extraClass}`;
  return div;
}

/** Re-render the player's own hand */
function renderMyHand() {
  const wrap = $('my-hand-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  myHand.forEach(card => {
    const el      = buildCard(card, 'my-card');
    const isValid = isMyTurn && validCardIds.includes(card.id);

    if (isMyTurn) {
      el.classList.add(isValid ? 'valid-hint' : 'invalid');
    }

    // Click
    el.addEventListener('click', () => {
      if (!isMyTurn) return;
      if (!validCardIds.includes(card.id)) { sfxError(); toast('You cannot play that card right now.'); return; }
      socket.emit('playCard', { cardId: card.id });
    });

    // Drag
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      if (!isMyTurn || !validCardIds.includes(card.id)) { e.preventDefault(); return; }
      dragCardId = card.id;
      el.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragCardId = null;
    });

    wrap.appendChild(el);
  });
}

/** Put a played card into a trick slot */
function setTrickCard(serverPos, card) {
  const s  = slot(serverPos);
  const el = $(`ts-${s}`);
  if (!el) return;
  el.innerHTML = '';
  if (!card) return;
  el.appendChild(buildCard(card, 'trick-card played'));
}

/** Clear all 4 trick-slot positions */
function clearTrick() {
  ['top','bottom','left','right'].forEach(s => {
    const el = $(`ts-${s}`);
    if (el) el.innerHTML = '';
  });
  trickCards = {};
}

function showPowerCard(visible) {
  const wrap = $('power-card-wrap');
  if (wrap) wrap.style.display = visible ? 'block' : 'none';
}

function revealPowerCardUI(card) {
  const wrap = $('power-card-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  const lbl = document.createElement('div');
  lbl.className = 'power-lbl';
  lbl.textContent = 'Trump ✓';
  const cardEl = buildCard(card, 'sm');
  cardEl.style.animation = 'panelIn 0.4s ease-out';
  wrap.appendChild(lbl);
  wrap.appendChild(cardEl);
  wrap.style.display = 'block';
}

// ────────────────────────────────────────────
//  PLAYER NAME PLATES
// ────────────────────────────────────────────
function renderPlayers(ps) {
  ps.forEach(p => {
    if (p.position === myPosition) {
      $('p-name-bottom').textContent = p.name + ' (You)';
      const tb = $('p-team-bottom');
      tb.textContent  = `Team ${p.team}`;
      tb.className    = `p-team ${p.team}`;
    } else {
      const s  = slot(p.position);
      const nm = $(`p-name-${s}`);
      const tm = $(`p-team-${s}`);
      if (nm) nm.textContent = p.name;
      if (tm) { tm.textContent = `Team ${p.team}`; tm.className = `p-team ${p.team}`; }
    }
  });
}

function updateTricksDisplay(tricksWon) {
  $('tally-a').textContent = tricksWon.A;
  $('tally-b').textContent = tricksWon.B;
  players.forEach(p => {
    const team = teamOf(p.position);
    const s    = p.position === myPosition ? 'bottom' : slot(p.position);
    const el   = $(`p-tricks-${s}`);
    if (el) el.textContent = `${tricksWon[team]} tricks`;
  });
}

// ────────────────────────────────────────────
//  WAITING ROOM PLAYERS GRID
// ────────────────────────────────────────────
function renderPlayersGrid(ps) {
  const grid  = $('players-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const SEATS = ['Seat 1','Seat 2','Seat 3','Seat 4'];
  for (let i = 0; i < 4; i++) {
    const p   = ps.find(pl => pl.position === i);
    const div = document.createElement('div');
    div.className = `player-slot${p ? ' filled' : ''}`;
    if (p) {
      const team = teamOf(i);
      div.innerHTML = `
        <span style="font-size:1.2rem">${i === 0 ? '👑' : '🎴'}</span>
        <div>
          <div class="seat">${SEATS[i]}</div>
          <div class="pname">${p.name}</div>
        </div>
        <span class="team-badge ${team}">Team ${team}</span>`;
    } else {
      div.innerHTML = `
        <span style="font-size:1.2rem;opacity:0.3">⬜</span>
        <div>
          <div class="seat">${SEATS[i]}</div>
          <div class="pname" style="opacity:0.3">Empty</div>
        </div>`;
    }
    grid.appendChild(div);
  }
  const count = ps.length;
  const ws    = $('wait-status');
  if (ws) ws.textContent = count < 4
    ? `Waiting for players… (${count}/4)`
    : 'All players have joined!';
  const sb = $('start-btn');
  if (sb) sb.disabled = count < 4;
}

// ────────────────────────────────────────────
//  BIDDING PANEL
// ────────────────────────────────────────────
function openBidPanel(current, canPass) {
  $('bid-info-txt').textContent = current > 0
    ? `Current bid: ${current} — you must bid higher or pass`
    : 'No bid yet — open the bidding';

  [7, 8, 9].forEach(n => { $(`bid${n}`).disabled = (n <= current); });

  const nilBtn = $('bid-nil');
  nilBtn.disabled    = !canPass;
  nilBtn.textContent = canPass ? 'Pass (Nil)' : 'You MUST bid!';

  const logEl = $('bid-log');
  logEl.innerHTML = '';
  bidLog.forEach(entry => {
    const d = document.createElement('div');
    d.className   = 'bid-log-entry';
    const bidDisp = entry.bid === 'nil'
      ? '<span style="opacity:0.5">Pass</span>'
      : `<span class="bid-val">${entry.bid}</span>`;
    d.innerHTML = `${entry.name}: ${bidDisp}`;
    logEl.appendChild(d);
  });

  showOverlay('overlay-bid');
  sfxBid();
}

function placeBid(bid) {
  socket.emit('makeBid', { bid });
  hideOverlay('overlay-bid');
}

// ────────────────────────────────────────────
//  POWER CARD SELECTION PANEL
// ────────────────────────────────────────────
function openPowerCardPanel(hand) {
  const container = $('power-hand-cards');
  container.innerHTML = '';
  hand.forEach(card => {
    const el = buildCard(card, 'my-card');
    el.style.cursor  = 'pointer';
    el.style.marginLeft = '0';
    el.addEventListener('click', () => {
      socket.emit('choosePowerCard', { cardId: card.id });
      hideOverlay('overlay-powercard');
      toast('Power card placed face-down 🂠');
      sfxDeal();
    });
    container.appendChild(el);
  });
  showOverlay('overlay-powercard');
}

// ────────────────────────────────────────────
//  ROUND END PANEL
// ────────────────────────────────────────────
function openRoundEndPanel(data) {
  const { bid, bidderTeam, roundScore, totalScores, message, powerCard } = data;

  $('re-title').textContent  = `Round ${roundNumber} Over`;
  $('re-result').textContent = message;

  if (powerCard) {
    const pcEl = $('re-power-card');
    pcEl.innerHTML = '';
    pcEl.appendChild(buildCard(powerCard));
    $('re-power-reveal').style.display = 'flex';
  } else {
    $('re-power-reveal').style.display = 'none';
  }

  ['a', 'b'].forEach(t => {
    const T    = t.toUpperCase();
    const rVal = roundScore[T];
    const rDisp = rVal >= 0 ? `+${rVal}` : `${rVal}`;
    const roundEl = $(`re-round-${t}`);
    roundEl.textContent = rDisp;
    roundEl.className   = `s-round ${rVal > 0 ? 'plus' : rVal < 0 ? 'minus' : ''}`;
    $(`re-total-${t}`).textContent = `Total: ${totalScores[T]}`;
  });

  $('re-ready-info').textContent = '';
  showOverlay('overlay-roundend');
}

function onReadyNextRound() {
  socket.emit('readyForNextRound');
  $('re-ready-info').textContent = 'Waiting for other players…';
}

// ────────────────────────────────────────────
//  LOBBY ACTIONS (called from HTML onclick)
// ────────────────────────────────────────────
function onCreateRoom() {
  const name = $('inp-name').value.trim();
  if (!name) { $('lobby-error').textContent = 'Please enter your name'; sfxError(); return; }
  $('lobby-error').textContent = '';
  socket.emit('createRoom', { name });
}

function onJoinRoom() {
  const name = $('inp-name-join').value.trim();
  const code = $('inp-code').value.trim().toUpperCase();
  if (!name) { $('lobby-error').textContent = 'Please enter your name'; sfxError(); return; }
  if (!code || code.length < 4) { $('lobby-error').textContent = 'Enter a valid room code'; sfxError(); return; }
  $('lobby-error').textContent = '';
  socket.emit('joinRoom', { name, code });
}

function onStartGame() { socket.emit('startGame'); }

function onRestartGame() { socket.emit('restartGame'); }

function copyCode() {
  const code = $('disp-code').textContent;
  navigator.clipboard?.writeText(code).then(() => toast('Room code copied! 📋'));
}

function selectTarget(val) {
  selectedTarget = val;
  $('t30').classList.toggle('selected', val === 30);
  $('t50').classList.toggle('selected', val === 50);
  socket.emit('setTarget', { target: val });
}

// ────────────────────────────────────────────
//  DRAG-AND-DROP  (table as drop zone)
// ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const ring = $('trick-ring');
  if (!ring) return;
  ring.addEventListener('dragover', e => {
    if (isMyTurn && dragCardId) e.preventDefault();
  });
  ring.addEventListener('drop', e => {
    e.preventDefault();
    const cid = e.dataTransfer.getData('text/plain') || dragCardId;
    if (cid && isMyTurn && validCardIds.includes(cid)) {
      socket.emit('playCard', { cardId: cid });
    }
  });
});

// ────────────────────────────────────────────
//  SCORE BAR
// ────────────────────────────────────────────
function updateScoreBar() {
  $('score-a').textContent  = scores.A;
  $('score-b').textContent  = scores.B;
  $('lbl-round').textContent  = `Round ${roundNumber}`;
  $('lbl-target').textContent = `Target: ${matchTarget}`;
  $('lbl-trump').textContent  = trumpRevealed
    ? `Trump: ${SUIT_SYM[trumpSuit]} ${trumpSuit}`
    : 'Trump: Hidden';
}

// ────────────────────────────────────────────
//  SOCKET  →  LOBBY / WAITING ROOM
// ────────────────────────────────────────────
socket.on('roomCreated', ({ code, position, players: ps }) => {
  myPosition = position;
  players    = ps;
  $('disp-code').textContent = code;
  renderPlayersGrid(ps);
  $('settings-panel').style.display = 'block';
  showScreen('screen-waiting');
  toast(`Room created! Code: ${code}`);
});

socket.on('roomJoined', ({ code, position, players: ps }) => {
  myPosition = position;
  players    = ps;
  $('disp-code').textContent = code;
  renderPlayersGrid(ps);
  const sp = $('settings-panel');
  if (sp) sp.style.display = 'none';
  showScreen('screen-waiting');
  toast(`Joined room ${code}!`);
});

socket.on('playerJoined', ({ players: ps }) => {
  players = ps;
  renderPlayersGrid(ps);
  sfxDeal();
  toast(`${ps[ps.length - 1].name} joined!`);
});

socket.on('allReady', ({ players: ps }) => {
  players = ps;
  renderPlayersGrid(ps);
  toast('All 4 players ready! Host can now start the game.');
  if (myPosition === 0) {
    const sb = $('start-btn');
    if (sb) sb.disabled = false;
  }
});

socket.on('targetSet', ({ target }) => {
  matchTarget = target;
  $('t30')?.classList.toggle('selected', target === 30);
  $('t50')?.classList.toggle('selected', target === 50);
  toast(`Match target set to ${target} points`);
});

socket.on('gameReset', ({ players: ps }) => {
  players = ps;
  myHand = []; validCardIds = []; isMyTurn = false;
  trumpSuit = null; trumpRevealed = false;
  scores = { A:0, B:0 }; bidLog = [];
  hideAllOverlays();
  showScreen('screen-waiting');
  const sp = $('settings-panel');
  if (sp) sp.style.display = myPosition === 0 ? 'block' : 'none';
  renderPlayersGrid(ps);
  toast('Game reset — waiting for host to start');
});

// ────────────────────────────────────────────
//  SOCKET  →  ROUND START
// ────────────────────────────────────────────
socket.on('roundBegin', ({ roundNumber: rn, scores: sc, players: ps, matchTarget: mt }) => {
  roundNumber = rn; scores = sc; matchTarget = mt; players = ps;
  myHand = []; validCardIds = []; isMyTurn = false;
  trumpSuit = null; trumpRevealed = false; leadSuit = null;
  bidLog = []; trickCards = {};
  handCounts = { 0:0, 1:0, 2:0, 3:0 };

  hideAllOverlays();
  showScreen('screen-game');
  clearTrick();
  showPowerCard(false);
  renderPlayers(ps);
  updateTricksDisplay({ A:0, B:0 });
  updateScoreBar();
  $('trick-num').textContent  = 'Trick 1/13';
  $('status-strip').textContent = 'Dealing cards…';
  setTurnIndicator(-1);

  // Reset opponent card fans
  players.forEach(p => {
    if (p.position !== myPosition) updateOppCards(slot(p.position), 0);
  });

  sfxDeal();
});

socket.on('handUpdate', ({ hand }) => {
  myHand = hand;
  handCounts[myPosition] = hand.length;
  renderMyHand();
});

// ────────────────────────────────────────────
//  SOCKET  →  CALLING PHASE
// ────────────────────────────────────────────
socket.on('callingStarted', ({ callerPos, callerName }) => {
  setTurnIndicator(callerPos);
  $('status-strip').textContent = `${callerName} is deciding their bid…`;
});

socket.on('callingTurn', ({ callerPos, callerName, currentBid: cb }) => {
  currentBid = cb;
  setTurnIndicator(callerPos);
  $('status-strip').textContent = `${callerName} is deciding their bid…`;
});

socket.on('yourCallingTurn', ({ currentBid: cb, canPass }) => {
  currentBid = cb;
  openBidPanel(cb, canPass);
});

socket.on('bidEvent', ({ type, pos, name, bid }) => {
  if (type === 'pass') {
    bidLog.push({ name, bid: 'nil' });
    toast(`${name} passed`);
    $('status-strip').textContent = `${name} passed`;
  } else if (type === 'bid') {
    bidLog.push({ name, bid });
    currentBid = bid; currentBidder = pos;
    toast(`${name} bid ${bid}!`);
    sfxBid();
    $('status-strip').textContent = `${name} bid ${bid} — placing power card…`;
  } else if (type === 'cardReturned') {
    toast(`${name}'s power card was returned`);
  }
});

socket.on('powerCardReturned', () => {
  toast('Your power card was returned to your hand');
});

socket.on('selectPowerCard', ({ hand }) => {
  myHand = hand;
  renderMyHand();
  openPowerCardPanel(hand);
});

socket.on('powerCardPlaced', ({ bidderPos, bidderName, bid }) => {
  currentBidder = bidderPos;
  showPowerCard(true);
  $('status-strip').textContent = `${bidderName} placed power card (bid: ${bid})`;
  toast(`${bidderName} placed their power card face-down`);
});

socket.on('callingDone', ({ bidder, bidderName, bid }) => {
  currentBidder = bidder;
  $('status-strip').textContent = `${bidderName} wins bid at ${bid}. Dealing remaining cards…`;
  toast(`${bidderName} wins the bid at ${bid}!`);
});

// ────────────────────────────────────────────
//  SOCKET  →  DEALING
// ────────────────────────────────────────────
socket.on('fullHandDealt', ({ hand, bidder, bid, powerCardSuit: pcs }) => {
  myHand       = hand;
  powerCardSuit = pcs;

  // Update hand counts — bidder has 12 cards (one is the face-down power card)
  for (let i = 0; i < 4; i++) handCounts[i] = 13;
  handCounts[bidder] = 12;

  players.forEach(p => {
    if (p.position !== myPosition)
      updateOppCards(slot(p.position), handCounts[p.position]);
  });

  renderMyHand();
  sfxDeal();

  if (myPosition === bidder && pcs) {
    const sym = SUIT_SYM[pcs];
    $('lbl-trump').textContent = `Trump: Hidden (${sym} ${pcs})`;
    toast(`Your power card suit is ${sym} ${pcs} — keep it secret!`, 3500);
  }
});

socket.on('dealingComplete', ({ bidderName, bid }) => {
  $('status-strip').textContent = `${bidderName} bid ${bid}. All cards dealt — game starting!`;
});

// ────────────────────────────────────────────
//  SOCKET  →  PLAYING PHASE
// ────────────────────────────────────────────
socket.on('playingStarted', ({ currentPlayer: cp, currentPlayerName, trickNumber }) => {
  currentPlayer = cp;
  setTurnIndicator(cp);
  $('status-strip').textContent = `${currentPlayerName}'s turn to lead Trick 1`;
  $('trick-num').textContent    = `Trick ${trickNumber}/13`;
});

socket.on('turnChanged', ({ currentPlayer: cp, currentPlayerName }) => {
  currentPlayer = cp;
  setTurnIndicator(cp);
  if (cp !== myPosition) {
    isMyTurn     = false;
    validCardIds = [];
    renderMyHand();
    $('status-strip').textContent = `${currentPlayerName}'s turn to play`;
  }
});

socket.on('yourTurn', ({ validCardIds: vids, leadSuit: ls, trumpSuit: ts, trumpRevealed: tr }) => {
  isMyTurn     = true;
  validCardIds = vids;
  leadSuit     = ls;
  if (tr) { trumpSuit = ts; trumpRevealed = tr; }
  renderMyHand();
  const hint = ls
    ? `Your turn — follow ${SUIT_SYM[ls]} ${ls} or discard`
    : 'Your turn — lead any card';
  $('status-strip').textContent = hint;
});

socket.on('cardPlayed', ({ position, name, card, trickSoFar, trumpReveal }) => {
  setTrickCard(position, card);
  trickCards[position] = card;

  // Decrement opponent hand visual
  if (position !== myPosition) {
    handCounts[position] = Math.max(0, (handCounts[position] || 0) - 1);
    updateOppCards(slot(position), handCounts[position]);
  }

  sfxCardPlay();

  if (trumpReveal) {
    trumpSuit     = trumpReveal.trumpSuit;
    trumpRevealed = true;
    updateScoreBar();
    revealPowerCardUI(trumpReveal.powerCard);
    sfxTrumpReveal();
    toast(`🔥 Trump revealed: ${SUIT_SYM[trumpSuit]} ${trumpSuit}!`, 3000);
    $('status-strip').textContent = `Trump revealed: ${SUIT_SYM[trumpSuit]} ${trumpSuit}!`;
  }
});

socket.on('trickComplete', ({ winnerPos, winnerName, winnerTeam, trickCards: tc, tricksWon, trickNumber }) => {
  sfxTrickWin();
  updateTricksDisplay(tricksWon);
  $('status-strip').textContent = `${winnerName} (Team ${winnerTeam}) wins trick ${trickNumber}!`;
  toast(`${winnerName} wins the trick!`, 2000);
});

socket.on('newTrickStarting', ({ trickNumber, leader, leaderName }) => {
  clearTrick();
  leadSuit = null;
  $('trick-num').textContent    = `Trick ${trickNumber}/13`;
  $('status-strip').textContent = `${leaderName} leads Trick ${trickNumber}`;
});

// ────────────────────────────────────────────
//  SOCKET  →  ROUND & GAME END
// ────────────────────────────────────────────
socket.on('roundEnd', data => {
  scores = data.totalScores;
  updateScoreBar();
  updateTricksDisplay(data.tricksWon);
  isMyTurn     = false;
  validCardIds = [];
  renderMyHand();
  openRoundEndPanel(data);
});

socket.on('readyCount', ({ ready, total }) => {
  const el = $('re-ready-info');
  if (el) el.textContent = `${ready}/${total} players ready…`;
});

socket.on('gameOver', ({ winner, scores: sc }) => {
  hideAllOverlays();
  scores = sc;

  $('go-score-a').textContent = sc.A;
  $('go-score-b').textContent = sc.B;

  const banner = $('winner-banner');
  banner.textContent = `Team ${winner} Wins!`;
  banner.className   = `winner-team-banner ${winner}`;

  sfxGameWin();
  showScreen('screen-gameover');
});

socket.on('playerLeft', ({ name }) => {
  toast(`⚠ ${name} disconnected`, 3500);
});

socket.on('err', msg => {
  sfxError();
  toast(`⚠ ${msg}`, 3000);
  $('lobby-error') && ($('lobby-error').textContent = msg);
  $('wait-error')  && ($('wait-error').textContent  = msg);
});

// ────────────────────────────────────────────
//  KEYBOARD SHORTCUT (Enter to submit forms)
// ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const active = document.querySelector('.screen.active');
  if (!active) return;
  if (active.id === 'screen-lobby') {
    const joinInput = $('inp-code');
    if (joinInput === document.activeElement || $('inp-name-join') === document.activeElement) {
      onJoinRoom();
    } else {
      onCreateRoom();
    }
  }
});

// ────────────────────────────────────────────
//  INPUT FORMATTING
// ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const codeInput = $('inp-code');
  if (codeInput) {
    codeInput.addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase();
    });
  }
});
