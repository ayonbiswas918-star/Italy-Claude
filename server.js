/**
 * Italy Card Game - Server
 * A 4-player team-based trick-taking card game
 * Teams: A (positions 0 & 2) vs B (positions 1 & 3)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['spades','hearts','diamonds','clubs'];
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

/** Build a fresh 52-card deck */
function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ suit, rank, id: `${rank}_${suit}` });
  return deck;
}

/** Fisher-Yates shuffle */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Generate a unique 6-char room code */
function genCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

/** Returns 'A' or 'B' given a seat position */
function teamOf(pos) { return pos % 2 === 0 ? 'A' : 'B'; }
function otherTeam(t) { return t === 'A' ? 'B' : 'A'; }

/** Sort hand: by suit then descending rank */
function sortHand(hand) {
  const suitOrder = { spades: 0, hearts: 1, diamonds: 2, clubs: 3 };
  return [...hand].sort((a, b) => {
    if (a.suit !== b.suit) return suitOrder[a.suit] - suitOrder[b.suit];
    return RANK_VAL[b.rank] - RANK_VAL[a.rank];
  });
}

/** Returns true if `challenger` beats `current` in the context of the trick */
function cardBeats(challenger, current, leadSuit, trumpSuit, trumpRevealed) {
  const cTrump = trumpRevealed && challenger.suit === trumpSuit;
  const wTrump = trumpRevealed && current.suit === trumpSuit;

  if (cTrump && !wTrump) return true;
  if (!cTrump && wTrump) return false;
  if (cTrump && wTrump) return RANK_VAL[challenger.rank] > RANK_VAL[current.rank];

  // No trump involved — lead-suit card beats off-suit
  if (challenger.suit === leadSuit && current.suit !== leadSuit) return true;
  if (challenger.suit !== leadSuit && current.suit === leadSuit) return false;
  if (challenger.suit === leadSuit && current.suit === leadSuit)
    return RANK_VAL[challenger.rank] > RANK_VAL[current.rank];

  return false; // both off-suit, neither wins
}

// ─────────────────────────────────────────────
//  ROOM & GAME STATE
// ─────────────────────────────────────────────
const rooms = new Map(); // code → room

/** Room shape */
function createRoom(hostId, hostName) {
  return {
    code: null,
    players: [{ id: hostId, name: hostName, position: 0 }],
    settings: { matchTarget: 30 },
    gameState: null,
    readySet: new Set(),   // players who clicked "Next Round"
  };
}

/** Fresh game-state for one round */
function freshGameState(prevState, matchTarget) {
  return {
    phase: 'calling',           // calling | selectingPowerCard | dealing2 | playing | roundEnd | gameOver
    deck: [],
    hands: { 0:[], 1:[], 2:[], 3:[] },
    powerCard: null,            // { card, position }
    trumpSuit: null,
    trumpRevealed: false,
    currentBid: 0,
    currentBidder: -1,          // position
    callingTurn: 0,             // which position's turn to call
    currentPlayer: 0,
    currentTrick: [],           // [{ position, card }]
    leadSuit: null,
    tricksWon: { A:0, B:0 },
    scores: prevState ? { ...prevState.scores } : { A:0, B:0 },
    matchTarget: matchTarget,
    roundNumber: prevState ? prevState.roundNumber : 1,
    trickNumber: 1,
  };
}

// ─────────────────────────────────────────────
//  HELPER ACCESSORS
// ─────────────────────────────────────────────

function getPlayerName(room, pos) {
  return room.players.find(p => p.position === pos)?.name || `P${pos + 1}`;
}

function getSocket(room, pos) {
  const p = room.players.find(pl => pl.position === pos);
  return p ? io.sockets.sockets.get(p.id) : null;
}

function playersInfo(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, position: p.position, team: teamOf(p.position) }));
}

// ─────────────────────────────────────────────
//  GAME FLOW FUNCTIONS
// ─────────────────────────────────────────────

/** Kick off a fresh round: shuffle, deal 5, start calling */
function beginRound(room) {
  const gs = freshGameState(room.gameState, room.settings.matchTarget);
  room.gameState = gs;
  room.readySet.clear();

  // Shuffle & deal first 5 cards to each player
  gs.deck = shuffle(createDeck());
  for (let i = 0; i < 5; i++)
    for (let pos = 0; pos < 4; pos++)
      gs.hands[pos].push(gs.deck.shift());

  for (let pos = 0; pos < 4; pos++)
    gs.hands[pos] = sortHand(gs.hands[pos]);

  gs.phase = 'calling';

  io.to(room.code).emit('roundBegin', {
    roundNumber: gs.roundNumber,
    scores: gs.scores,
    players: playersInfo(room),
    matchTarget: gs.matchTarget,
  });

  // Send initial hands to each player
  room.players.forEach(p => {
    const s = getSocket(room, p.position);
    if (s) s.emit('handUpdate', { hand: gs.hands[p.position] });
  });

  // Brief delay then start calling
  setTimeout(() => startCalling(room), 600);
}

/** Announce the calling phase and prompt first caller */
function startCalling(room) {
  const gs = room.gameState;
  gs.callingTurn = 0;

  io.to(room.code).emit('callingStarted', {
    callerPos: 0,
    callerName: getPlayerName(room, 0),
    currentBid: 0,
  });

  promptCaller(room, 0, 0, true);
}

/** Send calling prompt to a specific player */
function promptCaller(room, pos, currentBid, canPass) {
  const s = getSocket(room, pos);
  if (s) s.emit('yourCallingTurn', { currentBid, canPass });
}

/** After a bid/pass, move calling turn forward */
function advanceCalling(room) {
  const gs = room.gameState;
  gs.callingTurn++;

  if (gs.callingTurn >= 4) {
    // Bidding over
    if (gs.currentBid === 0) {
      // Safety — force position-3 to have bid 7 (shouldn't reach here normally)
      gs.currentBid = 7;
      gs.currentBidder = 3;
    }
    io.to(room.code).emit('callingDone', {
      bidder: gs.currentBidder,
      bidderName: getPlayerName(room, gs.currentBidder),
      bid: gs.currentBid,
    });
    setTimeout(() => dealRemainingCards(room), 900);
    return;
  }

  // Last player (pos 3) MUST bid if nobody has bid yet
  const isForced = gs.callingTurn === 3 && gs.currentBid === 0;
  const canPass  = !isForced;

  io.to(room.code).emit('callingTurn', {
    callerPos: gs.callingTurn,
    callerName: getPlayerName(room, gs.callingTurn),
    currentBid: gs.currentBid,
    canPass,
  });
  promptCaller(room, gs.callingTurn, gs.currentBid, canPass);
}

/** Deal the remaining cards (8 per player in two rounds of 4) */
function dealRemainingCards(room) {
  const gs = room.gameState;
  gs.phase = 'dealing2';

  // Two rounds of 4 cards to each player
  for (let round = 0; round < 2; round++) {
    for (let pos = 0; pos < 4; pos++) {
      for (let i = 0; i < 4 && gs.deck.length > 0; i++) {
        gs.hands[pos].push(gs.deck.shift());
      }
    }
  }

  // Re-sort
  for (let pos = 0; pos < 4; pos++)
    gs.hands[pos] = sortHand(gs.hands[pos]);

  // Notify all; send power card suit to the bidder only
  room.players.forEach(p => {
    const s = getSocket(room, p.position);
    if (s) {
      s.emit('fullHandDealt', {
        hand: gs.hands[p.position],
        bidder: gs.currentBidder,
        bid: gs.currentBid,
        // Bidder sees their own power-card suit as a hint
        powerCardSuit: p.position === gs.currentBidder ? (gs.powerCard?.card?.suit ?? null) : null,
      });
    }
  });

  io.to(room.code).emit('dealingComplete', {
    bidder: gs.currentBidder,
    bidderName: getPlayerName(room, gs.currentBidder),
    bid: gs.currentBid,
  });

  setTimeout(() => startPlaying(room), 1000);
}

/** Begin playing phase: position 0 always leads the first trick */
function startPlaying(room) {
  const gs = room.gameState;
  gs.phase = 'playing';
  gs.currentPlayer = 0;
  gs.trickNumber = 1;

  io.to(room.code).emit('playingStarted', {
    currentPlayer: 0,
    currentPlayerName: getPlayerName(room, 0),
    trickNumber: 1,
  });

  sendYourTurn(room, 0);
}

/** Tell the current player it is their turn and which cards are valid */
function sendYourTurn(room, pos) {
  const gs = room.gameState;
  const s = getSocket(room, pos);

  io.to(room.code).emit('turnChanged', {
    currentPlayer: pos,
    currentPlayerName: getPlayerName(room, pos),
  });

  if (!s) return;

  const hand = gs.hands[pos];
  const validIds = computeValidCards(gs, pos, hand).map(c => c.id);

  s.emit('yourTurn', {
    validCardIds: validIds,
    leadSuit: gs.leadSuit,
    trumpSuit: gs.trumpRevealed ? gs.trumpSuit : null,
    trumpRevealed: gs.trumpRevealed,
  });
}

/** Determine which cards in `hand` the player at `pos` may legally play */
function computeValidCards(gs, pos, hand) {
  // Leading the trick: any card
  if (gs.currentTrick.length === 0) return hand;

  // Must follow suit if possible
  const leadCards = hand.filter(c => c.suit === gs.leadSuit);
  if (leadCards.length > 0) return leadCards;

  // No lead-suit cards
  if (gs.trumpRevealed) {
    const trumpCards = hand.filter(c => c.suit === gs.trumpSuit);
    if (trumpCards.length > 0) {
      // Special: if teammate is currently winning, allowed to discard instead
      const currentWinner = trickWinner(gs.currentTrick, gs.leadSuit, gs.trumpSuit, gs.trumpRevealed);
      if (currentWinner !== null && teamOf(currentWinner) === teamOf(pos)) {
        return hand; // Teammate winning → can discard
      }
      return trumpCards; // Must trump
    }
  }

  return hand; // No lead suit, no trump (or trump not revealed) → any card
}

/** Find the position currently winning the (incomplete) trick */
function trickWinner(trick, leadSuit, trumpSuit, trumpRevealed) {
  if (trick.length === 0) return null;
  let winner = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (cardBeats(trick[i].card, winner.card, leadSuit, trumpSuit, trumpRevealed))
      winner = trick[i];
  }
  return winner.position;
}

/** Resolve a completed 4-card trick */
function resolveTrick(room) {
  const gs = room.gameState;
  const trick = gs.currentTrick;

  let winner = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (cardBeats(trick[i].card, winner.card, gs.leadSuit, gs.trumpSuit, gs.trumpRevealed))
      winner = trick[i];
  }

  const winTeam = teamOf(winner.position);
  gs.tricksWon[winTeam]++;
  const total = gs.tricksWon.A + gs.tricksWon.B;

  io.to(room.code).emit('trickComplete', {
    winnerPos: winner.position,
    winnerName: getPlayerName(room, winner.position),
    winnerTeam: winTeam,
    trickCards: trick,
    tricksWon: gs.tricksWon,
    trickNumber: gs.trickNumber,
  });

  // Reset trick state
  gs.currentTrick = [];
  gs.leadSuit = null;
  gs.trickNumber++;

  if (total >= 13) {
    setTimeout(() => endRound(room), 2000);
  } else {
    gs.currentPlayer = winner.position;
    setTimeout(() => {
      io.to(room.code).emit('newTrickStarting', {
        trickNumber: gs.trickNumber,
        leader: gs.currentPlayer,
        leaderName: getPlayerName(room, gs.currentPlayer),
      });
      sendYourTurn(room, gs.currentPlayer);
    }, 2000);
  }
}

/** Calculate score and emit results after 13 tricks */
function endRound(room) {
  const gs = room.gameState;
  const callerTeam  = teamOf(gs.currentBidder);
  const oppTeam     = otherTeam(callerTeam);
  const callerTricks = gs.tricksWon[callerTeam];
  const oppTricks    = gs.tricksWon[oppTeam];

  const roundScore = { A: 0, B: 0 };
  let message = '';

  if (callerTricks >= gs.currentBid) {
    // Success
    roundScore[callerTeam] = gs.currentBid;
    message = `Team ${callerTeam} succeeded! Won ${callerTricks} tricks (needed ${gs.currentBid}).`;
  } else {
    // Failure
    roundScore[callerTeam] = -gs.currentBid;
    // Opponent gets points for every trick beyond 5
    roundScore[oppTeam] = Math.max(0, oppTricks - 5);
    message = `Team ${callerTeam} failed! Won only ${callerTricks} tricks (needed ${gs.currentBid}).`;
  }

  gs.scores.A += roundScore.A;
  gs.scores.B += roundScore.B;
  gs.phase = 'roundEnd';

  io.to(room.code).emit('roundEnd', {
    tricksWon: gs.tricksWon,
    bid: gs.currentBid,
    bidder: gs.currentBidder,
    bidderTeam: callerTeam,
    roundScore,
    totalScores: gs.scores,
    message,
    powerCard: gs.powerCard?.card ?? null,
  });

  // Check win condition
  if (gs.scores.A >= gs.matchTarget || gs.scores.B >= gs.matchTarget) {
    const winner = gs.scores.A >= gs.matchTarget ? 'A' : 'B';
    gs.phase = 'gameOver';
    setTimeout(() => {
      io.to(room.code).emit('gameOver', { winner, scores: gs.scores });
    }, 3500);
  }
}

// ─────────────────────────────────────────────
//  SOCKET EVENT HANDLERS
// ─────────────────────────────────────────────
io.on('connection', socket => {
  socket.data = {};

  // ── Lobby ──────────────────────────────────

  socket.on('createRoom', ({ name }) => {
    if (!name?.trim()) return socket.emit('err', 'Name required');
    const room = createRoom(socket.id, name.trim());
    const code = genCode();
    room.code = code;
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.position = 0;
    socket.emit('roomCreated', { code, position: 0, players: playersInfo(room) });
  });

  socket.on('joinRoom', ({ code, name }) => {
    if (!name?.trim()) return socket.emit('err', 'Name required');
    const uc = code?.toUpperCase();
    const room = rooms.get(uc);
    if (!room) return socket.emit('err', 'Room not found');
    if (room.players.length >= 4) return socket.emit('err', 'Room is full');
    if (room.gameState && room.gameState.phase !== 'roundEnd' && room.gameState.phase !== 'gameOver')
      return socket.emit('err', 'Game already in progress');

    const pos = room.players.length;
    room.players.push({ id: socket.id, name: name.trim(), position: pos });
    socket.join(uc);
    socket.data.roomCode = uc;
    socket.data.position = pos;

    socket.emit('roomJoined', { code: uc, position: pos, players: playersInfo(room) });
    socket.to(uc).emit('playerJoined', { players: playersInfo(room) });

    if (room.players.length === 4)
      io.to(uc).emit('allReady', { players: playersInfo(room) });
  });

  socket.on('setTarget', ({ target }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.position !== 0) return;
    room.settings.matchTarget = target;
    io.to(room.code).emit('targetSet', { target });
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.position !== 0 || room.players.length !== 4) return;
    beginRound(room);
  });

  // ── Calling Phase ──────────────────────────

  socket.on('makeBid', ({ bid }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'calling') return;
    const pos = socket.data.position;
    if (gs.callingTurn !== pos) return;

    const bidNum = parseInt(bid);
    const isForced = pos === 3 && gs.currentBid === 0;

    if (bid === 'nil') {
      if (isForced) return socket.emit('err', 'You must make a bid!');
      io.to(room.code).emit('bidEvent', { type: 'pass', pos, name: getPlayerName(room, pos) });
      advanceCalling(room);

    } else if ([7, 8, 9].includes(bidNum) && bidNum > gs.currentBid) {
      // Return previous bidder's power card
      if (gs.powerCard) {
        gs.hands[gs.currentBidder].push(gs.powerCard.card);
        gs.hands[gs.currentBidder] = sortHand(gs.hands[gs.currentBidder]);
        const prevSocket = getSocket(room, gs.currentBidder);
        if (prevSocket) {
          prevSocket.emit('handUpdate', { hand: gs.hands[gs.currentBidder] });
          prevSocket.emit('powerCardReturned', { yourCardBack: true });
        }
        io.to(room.code).emit('bidEvent', {
          type: 'cardReturned',
          pos: gs.currentBidder,
          name: getPlayerName(room, gs.currentBidder),
        });
        gs.powerCard = null;
      }

      gs.currentBid = bidNum;
      gs.currentBidder = pos;
      gs.phase = 'selectingPowerCard';

      io.to(room.code).emit('bidEvent', { type: 'bid', pos, name: getPlayerName(room, pos), bid: bidNum });
      socket.emit('selectPowerCard', { hand: gs.hands[pos] });

    } else {
      socket.emit('err', 'Invalid bid — must be higher than current bid');
    }
  });

  socket.on('choosePowerCard', ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'selectingPowerCard') return;
    const pos = socket.data.position;
    if (pos !== gs.currentBidder) return;

    const hand = gs.hands[pos];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return socket.emit('err', 'Invalid card');

    const [card] = hand.splice(idx, 1);
    gs.powerCard = { card, position: pos };
    gs.phase = 'calling';

    socket.emit('handUpdate', { hand: sortHand(hand) });
    io.to(room.code).emit('powerCardPlaced', {
      bidderPos: pos,
      bidderName: getPlayerName(room, pos),
      bid: gs.currentBid,
    });

    advanceCalling(room);
  });

  // ── Playing Phase ──────────────────────────

  socket.on('playCard', ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'playing') return;
    const pos = socket.data.position;
    if (gs.currentPlayer !== pos) return;

    const hand = gs.hands[pos];
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return socket.emit('err', 'Card not in hand');

    const card = hand[cardIdx];

    // Validate the play
    const valid = computeValidCards(gs, pos, hand);
    if (!valid.some(c => c.id === cardId)) {
      return socket.emit('err', 'That card is not a valid play right now');
    }

    // Remove from hand
    hand.splice(cardIdx, 1);

    // Reveal trump if this card's suit matches the power card suit (and trump not yet revealed)
    let trumpReveal = null;
    if (!gs.trumpRevealed && gs.powerCard && card.suit === gs.powerCard.card.suit) {
      gs.trumpRevealed = true;
      gs.trumpSuit = card.suit;
      trumpReveal = { trumpSuit: gs.trumpSuit, powerCard: gs.powerCard.card };
    }

    // Set lead suit for this trick
    if (gs.currentTrick.length === 0) gs.leadSuit = card.suit;

    gs.currentTrick.push({ position: pos, card });

    // Broadcast
    io.to(room.code).emit('cardPlayed', {
      position: pos,
      name: getPlayerName(room, pos),
      card,
      trickSoFar: gs.currentTrick,
      trumpReveal,
    });

    socket.emit('handUpdate', { hand: sortHand(hand) });

    if (gs.currentTrick.length === 4) {
      setTimeout(() => resolveTrick(room), 1500);
    } else {
      gs.currentPlayer = (gs.currentPlayer + 1) % 4;
      sendYourTurn(room, gs.currentPlayer);
    }
  });

  // ── Between Rounds ─────────────────────────

  socket.on('readyForNextRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.gameState || room.gameState.phase !== 'roundEnd') return;
    room.readySet.add(socket.id);

    io.to(room.code).emit('readyCount', {
      ready: room.readySet.size,
      total: room.players.length,
    });

    if (room.readySet.size >= room.players.length) {
      room.readySet.clear();
      room.gameState.roundNumber++;
      beginRound(room);
    }
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.position !== 0) return;
    room.gameState = null;
    room.readySet.clear();
    io.to(room.code).emit('gameReset', { players: playersInfo(room) });
  });

  // ── Disconnect ─────────────────────────────

  socket.on('disconnect', () => {
    const { roomCode, position } = socket.data;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const pIdx = room.players.findIndex(p => p.id === socket.id);
    if (pIdx !== -1) {
      const pName = room.players[pIdx].name;
      io.to(roomCode).emit('playerLeft', { name: pName, position });
    }
    // Clean up empty rooms
    const anyOnline = room.players.some(p => io.sockets.sockets.has(p.id));
    if (!anyOnline) rooms.delete(roomCode);
  });
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏  Italy Card Game running → http://localhost:${PORT}`));
