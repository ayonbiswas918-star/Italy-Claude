/**
 * Italy Card Game — Server v2
 * Fixes: dealer rotation, trump reveal logic, seat swap, calling order
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const RANKS    = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS    = ['spades','hearts','diamonds','clubs'];
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────
function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ suit, rank, id: `${rank}_${suit}` });
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function teamOf(pos)  { return pos % 2 === 0 ? 'A' : 'B'; }
function otherTeam(t) { return t === 'A' ? 'B' : 'A'; }

function sortHand(hand) {
  const suitOrder = { spades:0, hearts:1, diamonds:2, clubs:3 };
  return [...hand].sort((a, b) => {
    if (a.suit !== b.suit) return suitOrder[a.suit] - suitOrder[b.suit];
    return RANK_VAL[b.rank] - RANK_VAL[a.rank];
  });
}

function cardBeats(challenger, current, leadSuit, trumpSuit, trumpRevealed) {
  const cTrump = trumpRevealed && challenger.suit === trumpSuit;
  const wTrump = trumpRevealed && current.suit === trumpSuit;
  if (cTrump && !wTrump) return true;
  if (!cTrump && wTrump) return false;
  if (cTrump && wTrump)  return RANK_VAL[challenger.rank] > RANK_VAL[current.rank];
  if (challenger.suit === leadSuit && current.suit !== leadSuit) return true;
  if (challenger.suit !== leadSuit && current.suit === leadSuit) return false;
  if (challenger.suit === leadSuit && current.suit === leadSuit)
    return RANK_VAL[challenger.rank] > RANK_VAL[current.rank];
  return false;
}

// ─────────────────────────────────────────────
//  ROOM & GAME STATE
// ─────────────────────────────────────────────
const rooms = new Map();

function createRoom(hostId, hostName) {
  return {
    code:      null,
    players:   [{ id: hostId, name: hostName, position: 0 }],
    settings:  { matchTarget: 30 },
    gameState: null,
    readySet:  new Set(),
  };
}

/**
 * Dealer rotation logic:
 *   Round 1 → dealer=0, callingStart=1  (P1 deals, P2 starts calling & leads)
 *   Round 2 → dealer=1, callingStart=2  (P2 deals, P3 starts calling & leads)
 *   Round 3 → dealer=2, callingStart=3
 *   Round 4 → dealer=3, callingStart=0
 *
 *   Calling order: callingStart → callingStart+1 → callingStart+2 → dealer (must bid)
 */
function freshGameState(prevState, matchTarget) {
  const dealerPos    = prevState ? (prevState.dealerPos + 1) % 4 : 0;
  const callingStart = (dealerPos + 1) % 4;
  return {
    phase: 'calling',
    deck:  [],
    hands: { 0:[], 1:[], 2:[], 3:[] },
    powerCard:     null,
    trumpSuit:     null,
    trumpRevealed: false,
    currentBid:    0,
    currentBidder: -1,
    dealerPos,
    callingStart,
    callingTurn:  callingStart,
    callingCount: 0,
    currentPlayer: callingStart,
    currentTrick:  [],
    leadSuit:      null,
    tricksWon:     { A:0, B:0 },
    scores:        prevState ? { ...prevState.scores } : { A:0, B:0 },
    matchTarget,
    roundNumber:   prevState ? prevState.roundNumber : 1,
    trickNumber:   1,
  };
}

function getPlayerName(room, pos) {
  return room.players.find(p => p.position === pos)?.name || `P${pos + 1}`;
}

function getSocket(room, pos) {
  const p = room.players.find(pl => pl.position === pos);
  return p ? io.sockets.sockets.get(p.id) : null;
}

function playersInfo(room) {
  return room.players.map(p => ({ id:p.id, name:p.name, position:p.position, team:teamOf(p.position) }));
}

// ─────────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────────
function beginRound(room) {
  const gs = freshGameState(room.gameState, room.settings.matchTarget);
  room.gameState = gs;
  room.readySet.clear();

  gs.deck = shuffle(createDeck());

  // Deal 5 cards starting from player AFTER the dealer
  for (let i = 0; i < 5; i++)
    for (let offset = 1; offset <= 4; offset++) {
      const pos = (gs.dealerPos + offset) % 4;
      gs.hands[pos].push(gs.deck.shift());
    }

  for (let pos = 0; pos < 4; pos++)
    gs.hands[pos] = sortHand(gs.hands[pos]);

  gs.phase = 'calling';

  io.to(room.code).emit('roundBegin', {
    roundNumber:     gs.roundNumber,
    scores:          gs.scores,
    players:         playersInfo(room),
    matchTarget:     gs.matchTarget,
    dealerPos:       gs.dealerPos,
    dealerName:      getPlayerName(room, gs.dealerPos),
    firstActivePos:  gs.callingStart,
    firstActiveName: getPlayerName(room, gs.callingStart),
  });

  room.players.forEach(p => {
    const s = getSocket(room, p.position);
    if (s) s.emit('handUpdate', { hand: gs.hands[p.position], dealPhase: 'initial' });
  });

  setTimeout(() => startCalling(room), 800);
}

function startCalling(room) {
  const gs = room.gameState;
  io.to(room.code).emit('callingStarted', {
    callerPos:  gs.callingStart,
    callerName: getPlayerName(room, gs.callingStart),
    currentBid: 0,
  });
  promptCaller(room, gs.callingStart, 0, true);
}

function promptCaller(room, pos, currentBid, canPass) {
  const s = getSocket(room, pos);
  if (s) s.emit('yourCallingTurn', {
    currentBid,
    canPass,
    hand: room.gameState.hands[pos],
  });
}

function advanceCalling(room) {
  const gs = room.gameState;
  gs.callingCount++;

  if (gs.callingCount >= 4) {
    if (gs.currentBid === 0) { gs.currentBid = 7; gs.currentBidder = gs.dealerPos; }
    io.to(room.code).emit('callingDone', {
      bidder:     gs.currentBidder,
      bidderName: getPlayerName(room, gs.currentBidder),
      bid:        gs.currentBid,
    });
    setTimeout(() => dealRemainingCards(room), 1000);
    return;
  }

  gs.callingTurn = (gs.callingStart + gs.callingCount) % 4;
  const isForced = gs.callingCount === 3 && gs.currentBid === 0;

  io.to(room.code).emit('callingTurn', {
    callerPos:  gs.callingTurn,
    callerName: getPlayerName(room, gs.callingTurn),
    currentBid: gs.currentBid,
    canPass:    !isForced,
  });
  promptCaller(room, gs.callingTurn, gs.currentBid, !isForced);
}

function dealRemainingCards(room) {
  const gs = room.gameState;
  gs.phase = 'dealing2';

  for (let round = 0; round < 2; round++)
    for (let offset = 1; offset <= 4; offset++) {
      const pos = (gs.dealerPos + offset) % 4;
      for (let i = 0; i < 4 && gs.deck.length > 0; i++)
        gs.hands[pos].push(gs.deck.shift());
    }

  for (let pos = 0; pos < 4; pos++)
    gs.hands[pos] = sortHand(gs.hands[pos]);

  room.players.forEach(p => {
    const s = getSocket(room, p.position);
    if (s) s.emit('fullHandDealt', {
      hand:          gs.hands[p.position],
      bidder:        gs.currentBidder,
      bid:           gs.currentBid,
      powerCardSuit: p.position === gs.currentBidder ? (gs.powerCard?.card?.suit ?? null) : null,
    });
  });

  io.to(room.code).emit('dealingComplete', {
    bidder:     gs.currentBidder,
    bidderName: getPlayerName(room, gs.currentBidder),
    bid:        gs.currentBid,
  });

  setTimeout(() => startPlaying(room), 1200);
}

function startPlaying(room) {
  const gs = room.gameState;
  gs.phase         = 'playing';
  gs.currentPlayer = gs.callingStart;
  gs.trickNumber   = 1;

  io.to(room.code).emit('playingStarted', {
    currentPlayer:     gs.currentPlayer,
    currentPlayerName: getPlayerName(room, gs.currentPlayer),
    trickNumber:       1,
  });

  sendYourTurn(room, gs.currentPlayer);
}

function sendYourTurn(room, pos) {
  const gs       = room.gameState;
  const s        = getSocket(room, pos);
  const hand     = gs.hands[pos];
  const validIds = computeValidCards(gs, pos, hand).map(c => c.id);

  io.to(room.code).emit('turnChanged', {
    currentPlayer:     pos,
    currentPlayerName: getPlayerName(room, pos),
  });

  if (s) s.emit('yourTurn', {
    validCardIds:  validIds,
    leadSuit:      gs.leadSuit,
    trumpSuit:     gs.trumpRevealed ? gs.trumpSuit : null,
    trumpRevealed: gs.trumpRevealed,
  });
}

function computeValidCards(gs, pos, hand) {
  if (gs.currentTrick.length === 0) return hand;

  const leadCards = hand.filter(c => c.suit === gs.leadSuit);
  if (leadCards.length > 0) return leadCards;

  if (gs.trumpRevealed) {
    const trumpCards = hand.filter(c => c.suit === gs.trumpSuit);
    if (trumpCards.length > 0) {
      const winner = trickWinner(gs.currentTrick, gs.leadSuit, gs.trumpSuit, gs.trumpRevealed);
      if (winner !== null && teamOf(winner) === teamOf(pos)) return hand;
      return trumpCards;
    }
  }

  return hand;
}

function trickWinner(trick, leadSuit, trumpSuit, trumpRevealed) {
  if (!trick.length) return null;
  let w = trick[0];
  for (let i = 1; i < trick.length; i++)
    if (cardBeats(trick[i].card, w.card, leadSuit, trumpSuit, trumpRevealed)) w = trick[i];
  return w.position;
}

function resolveTrick(room) {
  const gs    = room.gameState;
  const trick = gs.currentTrick;
  let   w     = trick[0];
  for (let i = 1; i < trick.length; i++)
    if (cardBeats(trick[i].card, w.card, gs.leadSuit, gs.trumpSuit, gs.trumpRevealed)) w = trick[i];

  const winTeam = teamOf(w.position);
  gs.tricksWon[winTeam]++;
  const total = gs.tricksWon.A + gs.tricksWon.B;

  io.to(room.code).emit('trickComplete', {
    winnerPos:   w.position,
    winnerName:  getPlayerName(room, w.position),
    winnerTeam:  winTeam,
    trickCards:  trick,
    tricksWon:   gs.tricksWon,
    trickNumber: gs.trickNumber,
  });

  gs.currentTrick = [];
  gs.leadSuit     = null;
  gs.trickNumber++;

  if (total >= 13) {
    setTimeout(() => endRound(room), 2000);
  } else {
    gs.currentPlayer = w.position;
    setTimeout(() => {
      io.to(room.code).emit('newTrickStarting', {
        trickNumber: gs.trickNumber,
        leader:      gs.currentPlayer,
        leaderName:  getPlayerName(room, gs.currentPlayer),
      });
      sendYourTurn(room, gs.currentPlayer);
    }, 2000);
  }
}

function endRound(room) {
  const gs           = room.gameState;
  const callerTeam   = teamOf(gs.currentBidder);
  const oppTeam      = otherTeam(callerTeam);
  const roundScore   = { A:0, B:0 };

  if (gs.tricksWon[callerTeam] >= gs.currentBid) {
    roundScore[callerTeam] = gs.currentBid;
  } else {
    roundScore[callerTeam] = -gs.currentBid;
    roundScore[oppTeam]    = Math.max(0, gs.tricksWon[oppTeam] - 5);
  }

  gs.scores.A += roundScore.A;
  gs.scores.B += roundScore.B;
  gs.phase = 'roundEnd';

  const msg = gs.tricksWon[callerTeam] >= gs.currentBid
    ? `Team ${callerTeam} succeeded! Won ${gs.tricksWon[callerTeam]} tricks (needed ${gs.currentBid}).`
    : `Team ${callerTeam} failed! Won only ${gs.tricksWon[callerTeam]} tricks (needed ${gs.currentBid}).`;

  io.to(room.code).emit('roundEnd', {
    tricksWon:   gs.tricksWon,
    bid:         gs.currentBid,
    bidder:      gs.currentBidder,
    bidderTeam:  callerTeam,
    roundScore,
    totalScores: gs.scores,
    message:     msg,
    powerCard:   gs.powerCard?.card ?? null,
  });

  if (gs.scores.A >= gs.matchTarget || gs.scores.B >= gs.matchTarget) {
    const winner = gs.scores.A >= gs.matchTarget ? 'A' : 'B';
    gs.phase = 'gameOver';
    setTimeout(() => io.to(room.code).emit('gameOver', { winner, scores: gs.scores }), 3500);
  }
}

// ─────────────────────────────────────────────
//  SOCKET EVENTS
// ─────────────────────────────────────────────
io.on('connection', socket => {
  socket.data = {};

  socket.on('createRoom', ({ name }) => {
    if (!name?.trim()) return socket.emit('err', 'Name required');
    const room = createRoom(socket.id, name.trim());
    const code = genCode();
    room.code  = code;
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.position = 0;
    socket.emit('roomCreated', { code, position: 0, players: playersInfo(room) });
  });

  socket.on('joinRoom', ({ code, name }) => {
    if (!name?.trim()) return socket.emit('err', 'Name required');
    const uc   = code?.toUpperCase();
    const room = rooms.get(uc);
    if (!room) return socket.emit('err', 'Room not found');
    if (room.players.length >= 4) return socket.emit('err', 'Room is full');
    if (room.gameState && !['roundEnd','gameOver'].includes(room.gameState.phase))
      return socket.emit('err', 'Game already in progress');

    const pos = room.players.length;
    room.players.push({ id: socket.id, name: name.trim(), position: pos });
    socket.join(uc);
    socket.data.roomCode = uc;
    socket.data.position = pos;

    socket.emit('roomJoined', { code: uc, position: pos, players: playersInfo(room) });
    socket.to(uc).emit('playerJoined', { players: playersInfo(room) });
    if (room.players.length === 4) io.to(uc).emit('allReady', { players: playersInfo(room) });
  });

  /* Seat swap: click any slot in waiting room to move or swap */
  socket.on('swapSeat', ({ targetPos }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.gameState && !['roundEnd','gameOver'].includes(room.gameState.phase)) return;

    const myPos        = socket.data.position;
    if (targetPos === myPos) return;

    const myPlayer     = room.players.find(p => p.id === socket.id);
    const targetPlayer = room.players.find(p => p.position === targetPos);

    if (targetPlayer) {
      // Swap
      targetPlayer.position = myPos;
      myPlayer.position     = targetPos;
      socket.data.position  = targetPos;
      const tSock = io.sockets.sockets.get(targetPlayer.id);
      if (tSock) { tSock.data.position = myPos; tSock.emit('yourPosition', { position: myPos }); }
    } else {
      myPlayer.position    = targetPos;
      socket.data.position = targetPos;
    }

    socket.emit('yourPosition', { position: targetPos });
    io.to(room.code).emit('seatsUpdated', { players: playersInfo(room) });
  });

  socket.on('setTarget', ({ target }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.settings.matchTarget = target;
    io.to(room.code).emit('targetSet', { target });
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.players.length !== 4) return;
    const p0 = room.players.find(pl => pl.position === 0);
    if (!p0 || p0.id !== socket.id) return;
    beginRound(room);
  });

  socket.on('makeBid', ({ bid }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'calling') return;
    const pos = socket.data.position;
    if (gs.callingTurn !== pos) return;

    const bidNum   = parseInt(bid);
    const isForced = gs.callingCount === 3 && gs.currentBid === 0;

    if (bid === 'nil') {
      if (isForced) return socket.emit('err', 'You must make a bid!');
      io.to(room.code).emit('bidEvent', { type:'pass', pos, name: getPlayerName(room, pos) });
      advanceCalling(room);
    } else if ([7,8,9].includes(bidNum) && bidNum > gs.currentBid) {
      if (gs.powerCard) {
        gs.hands[gs.currentBidder].push(gs.powerCard.card);
        gs.hands[gs.currentBidder] = sortHand(gs.hands[gs.currentBidder]);
        const ps = getSocket(room, gs.currentBidder);
        if (ps) { ps.emit('handUpdate', { hand: gs.hands[gs.currentBidder] }); ps.emit('powerCardReturned', {}); }
        gs.powerCard = null;
      }
      gs.currentBid    = bidNum;
      gs.currentBidder = pos;
      gs.phase         = 'selectingPowerCard';
      io.to(room.code).emit('bidEvent', { type:'bid', pos, name: getPlayerName(room, pos), bid: bidNum });
      socket.emit('selectPowerCard', { hand: gs.hands[pos] });
    } else {
      socket.emit('err', 'Invalid bid — must be higher than current bid');
    }
  });

  socket.on('choosePowerCard', ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs  = room.gameState;
    if (gs.phase !== 'selectingPowerCard') return;
    const pos = socket.data.position;
    if (pos !== gs.currentBidder) return;

    const hand = gs.hands[pos];
    const idx  = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return socket.emit('err', 'Invalid card');

    const [card] = hand.splice(idx, 1);
    gs.powerCard = { card, position: pos };
    gs.phase     = 'calling';

    socket.emit('handUpdate', { hand: sortHand(hand) });
    io.to(room.code).emit('powerCardPlaced', {
      bidderPos:  pos,
      bidderName: getPlayerName(room, pos),
      bid:        gs.currentBid,
    });
    advanceCalling(room);
  });

  socket.on('playCard', ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs  = room.gameState;
    if (gs.phase !== 'playing') return;
    const pos = socket.data.position;
    if (gs.currentPlayer !== pos) return;

    const hand    = gs.hands[pos];
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return socket.emit('err', 'Card not in hand');
    const card = hand[cardIdx];

    if (!computeValidCards(gs, pos, hand).some(c => c.id === cardId))
      return socket.emit('err', 'That card is not a valid play right now');

    // ── TRUMP REVEAL: only when not leading AND couldn't follow suit AND played trump suit ──
    const isLeading      = gs.currentTrick.length === 0;
    const hadLeadSuit    = gs.leadSuit ? hand.some(c => c.suit === gs.leadSuit) : false;
    const isPlayingTrump = gs.powerCard && card.suit === gs.powerCard.card.suit;

    let trumpReveal = null;
    if (!gs.trumpRevealed && isPlayingTrump && !isLeading && !hadLeadSuit) {
      gs.trumpRevealed = true;
      gs.trumpSuit     = card.suit;
      trumpReveal      = { trumpSuit: gs.trumpSuit, powerCard: gs.powerCard.card };
    }

    hand.splice(cardIdx, 1);
    if (gs.currentTrick.length === 0) gs.leadSuit = card.suit;
    gs.currentTrick.push({ position: pos, card });

    io.to(room.code).emit('cardPlayed', {
      position: pos, name: getPlayerName(room, pos),
      card, trickSoFar: gs.currentTrick, trumpReveal,
    });
    socket.emit('handUpdate', { hand: sortHand(hand) });

    if (gs.currentTrick.length === 4) {
      setTimeout(() => resolveTrick(room), 1500);
    } else {
      gs.currentPlayer = (gs.currentPlayer + 1) % 4;
      sendYourTurn(room, gs.currentPlayer);
    }
  });

  socket.on('readyForNextRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState || room.gameState.phase !== 'roundEnd') return;
    room.readySet.add(socket.id);
    io.to(room.code).emit('readyCount', { ready: room.readySet.size, total: room.players.length });
    if (room.readySet.size >= room.players.length) {
      room.readySet.clear();
      room.gameState.roundNumber++;
      beginRound(room);
    }
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p0 = room.players.find(pl => pl.position === 0);
    if (!p0 || p0.id !== socket.id) return;
    room.gameState = null;
    room.readySet.clear();
    io.to(room.code).emit('gameReset', { players: playersInfo(room) });
  });

  socket.on('disconnect', () => {
    const { roomCode, position } = socket.data;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const pIdx = room.players.findIndex(p => p.id === socket.id);
    if (pIdx !== -1) io.to(roomCode).emit('playerLeft', { name: room.players[pIdx].name, position });
    if (!room.players.some(p => io.sockets.sockets.has(p.id))) rooms.delete(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏  Italy Card Game → http://localhost:${PORT}`));
