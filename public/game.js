/**
 * Italy Card Game — Client v2
 * Fixes: seat swap, dealer display, dealing animation, trump reveal, bid shows hand
 */

const socket = io();

// ────────────────────────────────────────────
//  STATE
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
let handCounts    = { 0:0, 1:0, 2:0, 3:0 };
let dragCardId    = null;
let dealerPos     = 0;

// ────────────────────────────────────────────
//  AUDIO
// ────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, dur=.12, type='sine', vol=.16) {
  try {
    const ctx=getAudioCtx(), osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type=type; osc.frequency.value=freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime+dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+dur);
  } catch(e){}
}
const sfxCardPlay    = () => playTone(440,.08,'square',.12);
const sfxDeal        = () => playTone(660,.06,'sine',.10);
const sfxBid         = () => playTone(392,.10,'triangle',.15);
const sfxError       = () => playTone(200,.15,'sawtooth',.12);
const sfxTrickWin    = () => { playTone(523,.15,'sine',.15); setTimeout(()=>playTone(659,.15,'sine',.12),120); };
const sfxTrumpReveal = () => { playTone(784,.2,'sine',.18); setTimeout(()=>playTone(1047,.25,'sine',.15),200); };
const sfxGameWin     = () => [523,659,784,1047].forEach((f,i)=>setTimeout(()=>playTone(f,.2,'sine',.15),i*150));

// ────────────────────────────────────────────
//  CONSTANTS & HELPERS
// ────────────────────────────────────────────
const SUIT_SYM   = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };
const SUIT_COLOR = { spades:'black', hearts:'red', diamonds:'red', clubs:'black' };

function teamOf(pos) { return pos % 2 === 0 ? 'A' : 'B'; }

/** Translate a server seat number to a visual slot name relative to my seat */
function slot(serverPos) {
  return ['bottom','right','top','left'][((serverPos - myPosition) + 4) % 4];
}

const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(name).classList.add('active');
}

function showOverlay(id)   { $(id).classList.add('open'); }
function hideOverlay(id)   { $(id).classList.remove('open'); }
function hideAllOverlays() { document.querySelectorAll('.overlay').forEach(o => o.classList.remove('open')); }

function toast(msg, dur=2800) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), dur+300);
}

// ────────────────────────────────────────────
//  CARD BUILDING
// ────────────────────────────────────────────
function buildCard(card, extraClass='') {
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

function buildCardBack(extraClass='') {
  const d = document.createElement('div');
  d.className = `card back ${extraClass}`;
  return d;
}

// ────────────────────────────────────────────
//  HAND RENDERING
// ────────────────────────────────────────────
function renderMyHand(animate=false) {
  const wrap = $('my-hand-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  myHand.forEach((card, i) => {
    const el      = buildCard(card, 'my-card');
    const isValid = isMyTurn && validCardIds.includes(card.id);
    if (isMyTurn) el.classList.add(isValid ? 'valid-hint' : 'invalid');
    if (animate) {
      el.classList.add('dealing');
      el.style.animationDelay = `${i * 55}ms`;
    }
    el.addEventListener('click', () => {
      if (!isMyTurn) return;
      if (!validCardIds.includes(card.id)) { sfxError(); toast('You cannot play that card now.'); return; }
      socket.emit('playCard', { cardId: card.id });
    });
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      if (!isMyTurn || !validCardIds.includes(card.id)) { e.preventDefault(); return; }
      dragCardId = card.id;
      el.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragCardId = null; });
    wrap.appendChild(el);
  });
}

// ────────────────────────────────────────────
//  TRICK SLOTS
// ────────────────────────────────────────────
function setTrickCard(serverPos, card) {
  const el = $(`ts-${slot(serverPos)}`);
  if (!el) return;
  el.innerHTML = '';
  if (card) el.appendChild(buildCard(card, 'trick-card played'));
}

function clearTrick() {
  ['top','bottom','left','right'].forEach(s => {
    const el = $(`ts-${s}`);
    if (el) el.innerHTML = '';
  });
}

// ────────────────────────────────────────────
//  TRUMP SIDE PANEL
// ────────────────────────────────────────────
function updateTrumpPanel() {
  const slot  = $('trump-card-slot');
  const suit  = $('trump-suit-display');
  const lbl   = slot?.parentElement?.querySelector('.trump-panel-label');

  if (!trumpRevealed) {
    if (slot) { slot.innerHTML = ''; slot.appendChild(buildCardBack('sm')); }
    if (suit) suit.textContent = 'Hidden';
    if (lbl)  lbl.textContent = 'TRUMP';
  } else {
    if (suit) suit.innerHTML = `${SUIT_SYM[trumpSuit]} <span style="font-size:.65rem">${trumpSuit}</span>`;
    if (lbl)  lbl.textContent = 'TRUMP ✓';
  }
}

function revealTrumpPanel(card) {
  const slot = $('trump-card-slot');
  if (!slot) return;
  slot.innerHTML = '';
  const c = buildCard(card, 'trump-card-face');
  c.style.animation = 'cardDeal .4s ease-out';
  slot.appendChild(c);
  updateTrumpPanel();
}

// ────────────────────────────────────────────
//  PLAYER NAMEPLATES
// ────────────────────────────────────────────
function renderPlayers(ps) {
  ps.forEach(p => {
    const s = p.position === myPosition ? 'bottom' : slot(p.position);
    const nm = $(`p-name-${s}`);
    const tm = $(`p-team-${s}`);
    if (nm) nm.textContent = p.position === myPosition ? p.name + ' (You)' : p.name;
    if (tm) { tm.textContent = `Team ${p.team}`; tm.className = `p-team ${p.team}`; }
  });
}

function markDealer(dPos) {
  // Clear all dealer tags
  ['top','bottom','left','right'].forEach(s => {
    const el = $(`p-dealer-${s}`);
    if (el) el.style.display = 'none';
  });
  const s  = dPos === myPosition ? 'bottom' : slot(dPos);
  const el = $(`p-dealer-${s}`);
  if (el) el.style.display = 'block';
}

function setTurnIndicator(serverPos) {
  ['top','bottom','left','right'].forEach(s => {
    const el = $(`turn-${s}`);
    if (el) el.style.display = 'none';
  });
  const tb = $('turn-banner');
  if (tb) tb.style.display = 'none';

  if (serverPos < 0) return;

  if (serverPos === myPosition) {
    if (tb) { tb.style.display = 'block'; tb.style.animation = 'none'; void tb.offsetWidth; tb.style.animation = 'bannerIn .3s ease-out'; }
    const el = $('turn-bottom');
    if (el) el.style.display = 'block';
  } else {
    const s  = slot(serverPos);
    const el = $(`turn-${s}`);
    if (el) el.style.display = 'block';
  }
}

function updateOppCards(visualSlot, count) {
  const el = $(`opp-cards-${visualSlot}`);
  if (!el) return;
  el.innerHTML = '';
  for (let i = 0; i < Math.min(count, 13); i++) {
    const d = document.createElement('div');
    d.className = 'card-back-sm';
    el.appendChild(d);
  }
}

function updateTricksDisplay(tricksWon) {
  $('tally-a').textContent = tricksWon.A;
  $('tally-b').textContent = tricksWon.B;
  players.forEach(p => {
    const s  = p.position === myPosition ? 'bottom' : slot(p.position);
    const el = $(`p-tricks-${s}`);
    if (el) el.textContent = `${tricksWon[teamOf(p.position)]} tricks`;
  });
}

// ────────────────────────────────────────────
//  SCORE BAR
// ────────────────────────────────────────────
function updateScoreBar() {
  $('score-a').textContent  = scores.A;
  $('score-b').textContent  = scores.B;
  $('lbl-round').textContent  = `Round ${roundNumber}`;
  $('lbl-target').textContent = `Target: ${matchTarget}`;
}

// ────────────────────────────────────────────
//  DEALING ANIMATION
// ────────────────────────────────────────────
function showDealingAnim(dealerName, firstActiveName) {
  const ov  = $('dealing-overlay');
  const row = $('dealing-cards-row');
  if (!ov || !row) return;

  $('dealing-title').textContent    = `${dealerName} is dealing…`;
  $('dealing-subtitle').textContent = `${firstActiveName} will start the bidding`;

  row.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const d = document.createElement('div');
    d.className = 'dealing-card-anim';
    d.style.animationDelay = `${i * 80}ms`;
    row.appendChild(d);
  }

  ov.classList.add('show');
  setTimeout(() => ov.classList.remove('show'), 2200);
}

// ────────────────────────────────────────────
//  WAITING ROOM
// ────────────────────────────────────────────
function renderPlayersGrid(ps) {
  const grid = $('players-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const SEATS = ['Seat 1','Seat 2','Seat 3','Seat 4'];
  for (let i = 0; i < 4; i++) {
    const p   = ps.find(pl => pl.position === i);
    const isMe = p && p.position === myPosition;
    const div = document.createElement('div');
    div.className = `player-slot${p ? ' filled' : ''}${isMe ? ' mine' : ''}`;

    if (p) {
      const team = teamOf(i);
      div.innerHTML = `
        <span class="slot-icon">${isMe ? '⭐' : i === 0 ? '👑' : '🎴'}</span>
        <div style="flex:1;min-width:0">
          <div class="seat">${SEATS[i]}${isMe ? ' <span class="mine-badge">(You)</span>' : ''}</div>
          <div class="pname">${p.name}</div>
        </div>
        <span class="team-badge ${team}">Team ${team}</span>`;
    } else {
      div.innerHTML = `
        <span class="slot-icon" style="opacity:.3">⬜</span>
        <div>
          <div class="seat">${SEATS[i]}</div>
          <div class="pname" style="opacity:.3">Empty</div>
        </div>`;
    }

    // Clicking another seat requests a swap/move
    if (!isMe) {
      div.addEventListener('click', () => requestSwap(i));
    }
    grid.appendChild(div);
  }

  const count = ps.length;
  const ws = $('wait-status');
  if (ws) ws.textContent = count < 4 ? `Waiting for players… (${count}/4)` : 'All 4 players ready!';
  const sb = $('start-btn');
  if (sb) sb.disabled = count < 4 || myPosition !== 0;

  // Show/hide settings panel based on whether I'm position 0
  const sp = $('settings-panel');
  if (sp) sp.style.display = myPosition === 0 ? 'block' : 'none';
}

function requestSwap(targetPos) {
  socket.emit('swapSeat', { targetPos });
}

// ────────────────────────────────────────────
//  BID PANEL
// ────────────────────────────────────────────
function openBidPanel(current, canPass, hand) {
  $('bid-info-txt').textContent = current > 0
    ? `Current bid: ${current} — bid higher or pass`
    : 'No bid yet — open the bidding!';

  [7,8,9].forEach(n => { $(`bid${n}`).disabled = (n <= current); });
  const nilBtn = $('bid-nil');
  nilBtn.disabled    = !canPass;
  nilBtn.textContent = canPass ? 'Pass (Nil)' : 'You MUST bid!';

  const logEl = $('bid-log');
  logEl.innerHTML = '';
  bidLog.forEach(entry => {
    const d = document.createElement('div');
    d.className = 'bid-log-entry';
    d.innerHTML = `${entry.name}: ${
      entry.bid === 'nil'
        ? '<span style="opacity:.5">Pass</span>'
        : `<span class="bid-val">${entry.bid}</span>`}`;
    logEl.appendChild(d);
  });

  // Show current hand in the preview strip
  const preview = $('bid-hand-preview');
  preview.innerHTML = '';
  if (hand && hand.length) {
    hand.forEach(card => {
      preview.appendChild(buildCard(card));
    });
  }

  showOverlay('overlay-bid');
  sfxBid();
}

function placeBid(bid) {
  socket.emit('makeBid', { bid });
  hideOverlay('overlay-bid');
}

// ────────────────────────────────────────────
//  POWER CARD SELECTION
// ────────────────────────────────────────────
function openPowerCardPanel(hand) {
  const c = $('power-hand-cards');
  c.innerHTML = '';
  hand.forEach(card => {
    const el = buildCard(card, 'my-card');
    el.style.marginLeft = '0';
    el.addEventListener('click', () => {
      socket.emit('choosePowerCard', { cardId: card.id });
      hideOverlay('overlay-powercard');
      toast('Power card placed face-down 🂠');
      sfxDeal();
    });
    c.appendChild(el);
  });
  showOverlay('overlay-powercard');
}

// ────────────────────────────────────────────
//  ROUND END PANEL
// ────────────────────────────────────────────
function openRoundEndPanel(data) {
  const { roundScore, totalScores, message, powerCard } = data;
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

  ['a','b'].forEach(t => {
    const T    = t.toUpperCase();
    const rVal = roundScore[T];
    const roundEl = $(`re-round-${t}`);
    roundEl.textContent = rVal >= 0 ? `+${rVal}` : `${rVal}`;
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
//  LOBBY ACTIONS (called from HTML)
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
  if (code.length < 4) { $('lobby-error').textContent = 'Enter a valid room code'; sfxError(); return; }
  $('lobby-error').textContent = '';
  socket.emit('joinRoom', { name, code });
}

function onStartGame()    { socket.emit('startGame'); }
function onRestartGame()  { socket.emit('restartGame'); }

function copyCode() {
  const code = $('disp-code').textContent;
  navigator.clipboard?.writeText(code).then(() => toast('Room code copied! 📋'));
}

let selectedTarget = 30;
function selectTarget(val) {
  selectedTarget = val;
  $('t30')?.classList.toggle('selected', val===30);
  $('t50')?.classList.toggle('selected', val===50);
  socket.emit('setTarget', { target: val });
}

// ────────────────────────────────────────────
//  DRAG-AND-DROP
// ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const ring = $('trick-ring');
  if (!ring) return;
  ring.addEventListener('dragover', e => { if (isMyTurn && dragCardId) e.preventDefault(); });
  ring.addEventListener('drop', e => {
    e.preventDefault();
    const cid = e.dataTransfer.getData('text/plain') || dragCardId;
    if (cid && isMyTurn && validCardIds.includes(cid)) socket.emit('playCard', { cardId: cid });
  });

  // Code input auto-uppercase
  const ci = $('inp-code');
  if (ci) ci.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
});

// ────────────────────────────────────────────
//  KEYBOARD SHORTCUT
// ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const active = document.querySelector('.screen.active');
  if (!active) return;
  if (active.id === 'screen-lobby') {
    if (['inp-code','inp-name-join'].includes(document.activeElement?.id)) onJoinRoom();
    else onCreateRoom();
  }
});

// ────────────────────────────────────────────
//  SOCKET: LOBBY / WAITING ROOM
// ────────────────────────────────────────────
socket.on('roomCreated', ({ code, position, players: ps }) => {
  myPosition = position; players = ps;
  $('disp-code').textContent = code;
  renderPlayersGrid(ps);
  showScreen('screen-waiting');
  toast(`Room created! Code: ${code}`);
});

socket.on('roomJoined', ({ code, position, players: ps }) => {
  myPosition = position; players = ps;
  $('disp-code').textContent = code;
  renderPlayersGrid(ps);
  showScreen('screen-waiting');
  toast(`Joined room ${code}!`);
});

socket.on('playerJoined', ({ players: ps }) => {
  players = ps;
  renderPlayersGrid(ps);
  sfxDeal();
  const newcomer = ps[ps.length - 1];
  toast(`${newcomer.name} joined as Seat ${newcomer.position + 1}!`);
});

socket.on('allReady', ({ players: ps }) => {
  players = ps;
  renderPlayersGrid(ps);
  toast('All 4 players ready! Seat 1 can start the game.');
});

socket.on('targetSet', ({ target }) => {
  matchTarget = target;
  $('t30')?.classList.toggle('selected', target===30);
  $('t50')?.classList.toggle('selected', target===50);
  toast(`Match target: ${target} points`);
});

/* Seat swap: server confirms our new position */
socket.on('yourPosition', ({ position }) => {
  myPosition = position;
  renderPlayersGrid(players);
  const sp = $('settings-panel');
  if (sp) sp.style.display = myPosition === 0 ? 'block' : 'none';
});

socket.on('seatsUpdated', ({ players: ps }) => {
  players = ps;
  renderPlayersGrid(ps);
  toast('Seats updated!');
  sfxDeal();
});

socket.on('gameReset', ({ players: ps }) => {
  players = ps;
  myHand = []; validCardIds = []; isMyTurn = false;
  trumpSuit = null; trumpRevealed = false; scores = { A:0, B:0 }; bidLog = [];
  hideAllOverlays();
  showScreen('screen-waiting');
  renderPlayersGrid(ps);
  toast('Game reset — waiting for Seat 1 to start');
});

// ────────────────────────────────────────────
//  SOCKET: ROUND START
// ────────────────────────────────────────────
socket.on('roundBegin', ({ roundNumber:rn, scores:sc, players:ps, matchTarget:mt,
                           dealerPos:dp, dealerName, firstActiveName }) => {
  roundNumber=rn; scores=sc; matchTarget=mt; players=ps; dealerPos=dp;
  myHand=[]; validCardIds=[]; isMyTurn=false;
  trumpSuit=null; trumpRevealed=false; leadSuit=null;
  bidLog=[]; handCounts={0:0,1:0,2:0,3:0};

  hideAllOverlays();
  showScreen('screen-game');
  clearTrick();
  updateScoreBar();
  renderPlayers(ps);
  markDealer(dp);
  updateTricksDisplay({ A:0, B:0 });
  updateTrumpPanel();
  $('trick-num').textContent    = 'Trick 1/13';
  $('status-strip').textContent = 'Dealing cards…';
  setTurnIndicator(-1);
  players.forEach(p => { if (p.position !== myPosition) updateOppCards(slot(p.position), 0); });

  // Show dealing animation
  showDealingAnim(dealerName, firstActiveName);
  sfxDeal();
});

socket.on('handUpdate', ({ hand, dealPhase }) => {
  myHand = hand;
  handCounts[myPosition] = hand.length;
  renderMyHand(dealPhase === 'initial'); // animate on initial deal
});

// ────────────────────────────────────────────
//  SOCKET: CALLING PHASE
// ────────────────────────────────────────────
socket.on('callingStarted', ({ callerPos, callerName }) => {
  setTurnIndicator(callerPos);
  $('status-strip').textContent = `${callerName} is deciding their bid…`;
});

socket.on('callingTurn', ({ callerPos, callerName, currentBid:cb }) => {
  currentBid = cb;
  setTurnIndicator(callerPos);
  $('status-strip').textContent = `${callerName} is deciding their bid…`;
});

socket.on('yourCallingTurn', ({ currentBid:cb, canPass, hand }) => {
  currentBid = cb;
  openBidPanel(cb, canPass, hand);
});

socket.on('bidEvent', ({ type, pos, name, bid }) => {
  if (type === 'pass') {
    bidLog.push({ name, bid:'nil' });
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

socket.on('powerCardReturned', () => toast('Your power card was returned to your hand'));

socket.on('selectPowerCard', ({ hand }) => {
  myHand = hand;
  renderMyHand();
  openPowerCardPanel(hand);
});

socket.on('powerCardPlaced', ({ bidderPos, bidderName, bid }) => {
  currentBidder = bidderPos;
  $('status-strip').textContent = `${bidderName} placed power card face-down (bid: ${bid})`;
  toast(`${bidderName} placed their power card`);
});

socket.on('callingDone', ({ bidder, bidderName, bid }) => {
  currentBidder = bidder;
  $('status-strip').textContent = `${bidderName} wins bid at ${bid}. Dealing remaining cards…`;
  toast(`${bidderName} wins the bid at ${bid}!`);
});

// ────────────────────────────────────────────
//  SOCKET: DEALING REMAINDER
// ────────────────────────────────────────────
socket.on('fullHandDealt', ({ hand, bidder, bid, powerCardSuit }) => {
  myHand = hand;
  for (let i=0; i<4; i++) handCounts[i] = 13;
  handCounts[bidder] = 12;
  players.forEach(p => { if (p.position !== myPosition) updateOppCards(slot(p.position), handCounts[p.position]); });
  renderMyHand(true); // animate with stagger
  sfxDeal();

  if (myPosition === bidder && powerCardSuit) {
    const sym = SUIT_SYM[powerCardSuit];
    toast(`Your power card suit is ${sym} ${powerCardSuit} — keep it secret!`, 3500);
  }
});

socket.on('dealingComplete', ({ bidderName, bid }) => {
  $('status-strip').textContent = `${bidderName} bid ${bid}. All cards dealt — game starting!`;
});

// ────────────────────────────────────────────
//  SOCKET: PLAYING PHASE
// ────────────────────────────────────────────
socket.on('playingStarted', ({ currentPlayer:cp, currentPlayerName, trickNumber }) => {
  currentPlayer = cp;
  setTurnIndicator(cp);
  $('status-strip').textContent = `${currentPlayerName} leads Trick 1`;
  $('trick-num').textContent    = `Trick ${trickNumber}/13`;
});

socket.on('turnChanged', ({ currentPlayer:cp, currentPlayerName }) => {
  currentPlayer = cp;
  setTurnIndicator(cp);
  if (cp !== myPosition) {
    isMyTurn=false; validCardIds=[];
    renderMyHand();
    $('status-strip').textContent = `${currentPlayerName}'s turn to play`;
  }
});

socket.on('yourTurn', ({ validCardIds:vids, leadSuit:ls, trumpSuit:ts, trumpRevealed:tr }) => {
  isMyTurn=true; validCardIds=vids; leadSuit=ls;
  if (tr) { trumpSuit=ts; trumpRevealed=tr; updateTrumpPanel(); }
  renderMyHand();
  $('status-strip').textContent = ls
    ? `Your turn — follow ${SUIT_SYM[ls]} ${ls}`
    : 'Your turn — lead any card';
});

socket.on('cardPlayed', ({ position, name, card, trumpReveal }) => {
  setTrickCard(position, card);
  if (position !== myPosition) {
    handCounts[position] = Math.max(0, (handCounts[position]||0)-1);
    updateOppCards(slot(position), handCounts[position]);
  }
  sfxCardPlay();

  if (trumpReveal) {
    trumpSuit=trumpReveal.trumpSuit; trumpRevealed=true;
    revealTrumpPanel(trumpReveal.powerCard);
    sfxTrumpReveal();
    toast(`🔥 Trump revealed: ${SUIT_SYM[trumpSuit]} ${trumpSuit}!`, 3000);
    $('status-strip').textContent = `Trump revealed: ${SUIT_SYM[trumpSuit]} ${trumpSuit}!`;
  }
});

socket.on('trickComplete', ({ winnerPos, winnerName, winnerTeam, tricksWon, trickNumber }) => {
  sfxTrickWin();
  updateTricksDisplay(tricksWon);
  $('status-strip').textContent = `${winnerName} (Team ${winnerTeam}) wins trick ${trickNumber}!`;
  toast(`${winnerName} wins the trick! 🎉`, 2000);
});

socket.on('newTrickStarting', ({ trickNumber, leader, leaderName }) => {
  clearTrick();
  leadSuit = null;
  $('trick-num').textContent    = `Trick ${trickNumber}/13`;
  $('status-strip').textContent = `${leaderName} leads Trick ${trickNumber}`;
});

// ────────────────────────────────────────────
//  SOCKET: ROUND & GAME END
// ────────────────────────────────────────────
socket.on('roundEnd', data => {
  scores=data.totalScores; updateScoreBar();
  updateTricksDisplay(data.tricksWon);
  isMyTurn=false; validCardIds=[]; renderMyHand();
  openRoundEndPanel(data);
});

socket.on('readyCount', ({ ready, total }) => {
  const el = $('re-ready-info');
  if (el) el.textContent = `${ready}/${total} players ready…`;
});

socket.on('gameOver', ({ winner, scores:sc }) => {
  hideAllOverlays(); scores=sc; updateScoreBar();
  $('go-score-a').textContent = sc.A;
  $('go-score-b').textContent = sc.B;
  const banner = $('winner-banner');
  banner.textContent = `Team ${winner} Wins!`;
  banner.className   = `winner-team-banner ${winner}`;
  sfxGameWin();
  showScreen('screen-gameover');
});

socket.on('playerLeft', ({ name }) => toast(`⚠ ${name} disconnected`, 3500));

socket.on('err', msg => {
  sfxError(); toast(`⚠ ${msg}`, 3000);
  const le = $('lobby-error'); if (le) le.textContent = msg;
  const we = $('wait-error');  if (we) we.textContent  = msg;
});
