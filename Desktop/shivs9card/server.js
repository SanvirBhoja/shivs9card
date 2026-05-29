require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
});

// ── Serve built React app ──────────────────────────────────────
// ── Recent Games ───────────────────────────────────────────────
const recentGames = []; // max 5, in-memory

app.get('/api/recent-games', (req, res) => {
  const player = String(req.query.player || '').trim().toLowerCase();
  const games = player ? recentGames.filter(g => (g.participants || []).some(n => String(n).toLowerCase() === player)) : recentGames;
  res.json(games.slice(0,5));
});

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size, uptime: Math.floor(process.uptime()), version: '1.0.7' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Shared game logic (mirrors client) ────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RV = {A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13};
const rv = (r,hi=false) => r==='A'?(hi?14:1):(RV[r]||0);
const nextRank = r => r==='JOKER'?null:RANKS[(RANKS.indexOf(r)+1)%RANKS.length];
let _uid = 0;

function makeDeck(){
  _uid=0; const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({suit:s,rank:r,id:_uid++,isWild:false});
  d.push({suit:'★',rank:'JOKER',id:_uid++,isWild:true});
  d.push({suit:'★',rank:'JOKER',id:_uid++,isWild:true});
  return d;
}
function shuffle(a){const d=[...a];for(let i=d.length-1;i>0;i--){const j=0|Math.random()*(i+1);[d[i],d[j]]=[d[j],d[i]];}return d;}
function markWilds(cards,wr){return cards.map(c=>({...c,isWild:c.rank==='JOKER'||c.rank===wr}));}

// Returns true if cards form a "donkey" set (same rank, all different suits, 3-4 cards)
function isDonutSet(cards){
  if(cards.length<3||cards.length>4)return false;
  const nw=cards.filter(c=>!c.isWild);
  if(!nw.length)return false;
  const rank=nw[0].rank;
  if(!nw.every(c=>c.rank===rank))return false;
  const suits=nw.map(c=>c.suit);
  return new Set(suits).size===suits.length; // all different suits
}

// Returns the single suit used in a run-set (null if donkey/mixed)
function getRunSuit(cards){
  const nw=cards.filter(c=>!c.isWild);
  if(!nw.length)return null;
  const suit=nw[0].suit;
  return nw.every(c=>c.suit===suit)?suit:null;
}

// Get all suits currently represented in table run-sets
function suitsOnTable(tableSets){
  const s=new Set();
  for(const ts of tableSets){const rs=getRunSuit(ts.cards);if(rs)s.add(rs);}
  return s;
}


function canPlayDonkeySet(tableSets,cards){
  if(!isDonutSet(cards))return false;
  const represented=suitsOnTable(tableSets);
  cards.filter(c=>!c.isWild&&SUITS.includes(c.suit)).forEach(c=>represented.add(c.suit));
  const wildCount=cards.filter(c=>c.isWild).length;
  return represented.size+wildCount>=4;
}
function appendMove(game,msg){
  return {...game,moveHistory:[...(game.moveHistory||[]),msg].slice(-8),message:msg};
}
function validMeld(cards){
  if(cards.length<3)return false;
  const w=cards.filter(c=>c.isWild),nw=cards.filter(c=>!c.isWild);
  if(!nw.length)return false;
  // Donkey set: same rank, different suits
  if(isDonutSet(cards))return true;
  // Suit run
  const suit=nw[0].suit;
  if(nw.some(c=>c.suit!==suit))return false;
  for(const hi of[false,true]){
    const vals=nw.map(c=>rv(c.rank,hi)).sort((a,b)=>a-b);
    if(new Set(vals).size!==vals.length)continue;
    const span=vals[vals.length-1]-vals[0]+1,gaps=span-nw.length;
    if(gaps<=w.length){const extra=w.length-gaps;for(let s=Math.max(1,vals[0]-extra);s<=vals[0];s++)if(s+cards.length-1<=14)return true;}
  }
  return false;
}
function canAdd(ex,c){return validMeld([...ex,c]);}

function findBestMeld(hand,min){
  const w=hand.filter(c=>c.isWild),nw=hand.filter(c=>!c.isWild);let best=null;
  for(const suit of SUITS)for(const hi of[false,true]){
    const sc=nw.filter(c=>c.suit===suit).map(c=>({...c,_v:rv(c.rank,hi)})).sort((a,b)=>a._v-b._v);
    for(let i=0;i<sc.length;i++)for(let j=i;j<sc.length;j++){
      const sl=sc.slice(i,j+1),vals=sl.map(c=>c._v);
      if(new Set(vals).size!==vals.length)continue;
      const span=vals[vals.length-1]-vals[0]+1,gaps=span-sl.length;
      for(let wi=gaps;wi<=w.length;wi++){const m=[...sl,...w.slice(0,wi)];if(m.length>=min&&validMeld(m)&&(!best||m.length>best.length))best=m;}
    }
  }
  return best;
}
function findAddToSet(hand,sets){for(const c of hand)for(let i=0;i<sets.length;i++)if(canAdd(sets[i].cards,c))return{card:c,idx:i};return null;}
function pickDiscard(hand){const nw=hand.filter(c=>!c.isWild);if(!nw.length)return hand[0];return nw.reduce((w,c)=>{const cs=nw.filter(x=>x.suit===c.suit&&Math.abs(rv(x.rank)-rv(c.rank))<=3).length,ws=nw.filter(x=>x.suit===w.suit&&Math.abs(rv(x.rank)-rv(w.rank))<=3).length;return cs<ws?c:w;});}
function findTwoMelds(cards){if(cards.length<7)return null;const f=findBestMeld(cards,4);if(!f)return null;const ids=new Set(f.map(c=>c.id));const s=findBestMeld(cards.filter(c=>!ids.has(c.id)),3);return s?[f,s]:null;}

function reshuffleTableSets(deck,disc,sets,wr){
  if(deck.length||disc.length)return{deck,disc,sets};
  const rec=[];sets.forEach(s=>s.cards.forEach(c=>rec.push(c)));
  if(!rec.length)return{deck,disc,sets};
  return{deck:markWilds(shuffle(rec),wr),disc:[],sets:[]};
}

function initGame(playerList, startPlayer=0){
  _uid=0;
  let deck=shuffle(makeDeck());
  const players=playerList.map((p,i)=>({...p,id:i,hand:[],hasComDown:false}));
  for(let c=0;c<9;c++)for(const p of players)p.hand.push(deck.pop());
  let fl=deck.pop();while(fl.rank==='JOKER'){deck.unshift(fl);fl=deck.pop();}
  const wr=nextRank(fl.rank);
  deck=markWilds(deck,wr);for(const p of players)p.hand=markWilds(p.hand,wr);
  return{deck,discardPile:[],flipped:fl,wildRank:wr,players,currentPlayer:startPlayer,tableSets:[],
    phase:'draw',winner:null,wildWin:false,wildConfirmed:false,moveHistory:[]};
}

function runAiTurn(game){
  const players=game.players.map(p=>({...p,hand:[...p.hand]}));
  let deck=[...game.deck],disc=[...game.discardPile];
  let sets=game.tableSets.map(s=>({...s,cards:[...s.cards]}));
  const cur=game.currentPlayer,p=players[cur];

  const top=disc[disc.length-1];
  const pickup=top&&!top.isWild&&(()=>{const h=[...p.hand,top];return!!(findBestMeld(h,p.hasComDown?3:4)||findAddToSet([top],sets));})();
  if(pickup)p.hand.push(disc.pop());
  else if(deck.length)p.hand.push(deck.pop());
  else if(disc.length)p.hand.push(disc.pop());
  else{const r=reshuffleTableSets(deck,disc,sets,game.wildRank);deck=r.deck;disc=r.disc;sets=r.sets;if(deck.length)p.hand.push(deck.pop());}

  if(!p.hasComDown){
    const meldOk=(m)=>{const es=suitsOnTable(sets);if(isDonutSet(m))return es.size>=4;const ms=getRunSuit(m);return!ms||!es.has(ms);};
    const two=findTwoMelds(p.hand);
    if(two&&two.every(m=>meldOk(m))){for(const m of two){const ids=new Set(m.map(c=>c.id));p.hand=p.hand.filter(c=>!ids.has(c.id));sets.push({playerId:p.id,playerName:p.name,cards:m});}p.hasComDown=true;if(!p.hand.length)return{...game,players,tableSets:sets,winner:p.id,wildWin:two.flat().some(c=>c.isWild)};}
    else{const m=findBestMeld(p.hand,4);if(m&&meldOk(m)){const ids=new Set(m.map(c=>c.id));p.hand=p.hand.filter(c=>!ids.has(c.id));sets.push({playerId:p.id,playerName:p.name,cards:m});p.hasComDown=true;if(!p.hand.length)return{...game,players,tableSets:sets,winner:p.id,wildWin:m.some(c=>c.isWild)};}}
  }
  if(p.hasComDown){
    let ch=true,g=0;
    while(ch&&g++<40){ch=false;
      const r=findAddToSet(p.hand,sets);if(r){p.hand=p.hand.filter(c=>c.id!==r.card.id);sets[r.idx].cards.push(r.card);if(!p.hand.length)return{...game,players,tableSets:sets,winner:p.id,wildWin:r.card.isWild};ch=true;}
      const m=findBestMeld(p.hand,3);if(m){const es=suitsOnTable(sets);const ok=isDonutSet(m)?es.size>=4:(!getRunSuit(m)||!es.has(getRunSuit(m)));if(ok){const ids=new Set(m.map(c=>c.id));p.hand=p.hand.filter(c=>!ids.has(c.id));sets.push({playerId:p.id,playerName:p.name,cards:m});if(!p.hand.length)return{...game,players,tableSets:sets,winner:p.id,wildWin:m.some(c=>c.isWild)};ch=true;}}
    }
  }
  const dc=pickDiscard(p.hand);p.hand=p.hand.filter(c=>c.id!==dc.id);disc.push(dc);
  if(!p.hand.length)return{...game,players,discardPile:disc,tableSets:sets,winner:p.id,wildWin:dc.isWild};
  if(!deck.length&&disc.length>1){const top=disc.pop();deck=shuffle([...disc]);disc=[top];}
  else if(!deck.length&&!disc.length){const r=reshuffleTableSets(deck,disc,sets,game.wildRank);deck=r.deck;disc=r.disc;sets=r.sets;}
  const next=(cur+1)%players.length;
  return{...game,players,deck,discardPile:disc,tableSets:sets,currentPlayer:next,phase:'draw'};
}

// ── Room management ────────────────────────────────────────────
const rooms = new Map();

function genCode(){return Math.random().toString(36).slice(2,7).toUpperCase();}
function genToken(){return crypto.randomBytes(16).toString('hex');}

// ── Server-side scoring ────────────────────────────────────────
function serverCardPoints(card){
  if(card.isWild)return 30;
  if(['J','Q','K'].includes(card.rank))return 10;
  if(card.rank==='A')return 11;
  return parseInt(card.rank)||0;
}
function serverScorePlayer(player){
  if(!player.hand.length)return{total:0,noSet:false,items:[]};
  const items=[];let total=0;
  if(!player.hasComDown){items.push({label:'No set played',pts:30});total+=30;}
  for(const c of player.hand){
    const pts=serverCardPoints(c);
    items.push({label:c.rank+(c.suit!=='★'?c.suit:'🃏'),pts});
    total+=pts;
  }
  return{total,noSet:!player.hasComDown,items};
}

function playerView(game, myIdx){
  return {
    ...game,
    myPlayerIdx: myIdx,
    players: game.players.map((p,i) => ({
      ...p,
      hand: i === myIdx ? p.hand : p.hand.map(() => ({ hidden: true })),
    })),
  };
}

function broadcastGame(roomCode, game){
  const room = rooms.get(roomCode);
  if(!room) return;
  if(game.winner !== null && game.winner !== undefined){
    // Game over — send full unhidden state + scores so all clients can show results
    const scores = game.players.map(p => {
      const base = serverScorePlayer(p);
      const wonWithWild = game.winner === p.id && !!game.wildWin;
      return {
        id: p.id,
        name: p.name,
        ...base,
        total: wonWithWild ? 30 : base.total,
        items: wonWithWild ? [{ label: 'Won with Joker/Wild', pts: 30 }] : base.items,
        hand: p.hand,
        hasComDown: p.hasComDown,
        wildWin: wonWithWild,
      };
    });
    room.players.forEach((rp, idx) => {
      if(rp.socketId){
        io.to(rp.socketId).emit('game_state', { ...game, myPlayerIdx: idx, players: game.players });
        io.to(rp.socketId).emit('round_end', { winner: game.winner, scores, wildWin: game.wildWin||false });
      }
    });
  } else {
    room.players.forEach((rp, idx) => {
      if(rp.socketId) io.to(rp.socketId).emit('game_state', playerView(game, idx));
    });
  }
}

// ── Socket.io ──────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('+ connected', socket.id);

  socket.on('create_room', ({ playerName }) => {
    const code = genCode();
    const room = {
      code,
      players: [{ socketId: socket.id, name: playerName, isHost: true, ready: true, token: genToken() }],
      game: null,
      series: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room_joined', { code, room: sanitiseRoom(room), isHost: true, playerToken: room.players[0].token });
  });

  socket.on('join_room', ({ code, playerName, playerToken }) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const cleanName = String(playerName || '').trim();
    const cleanToken = String(playerToken || '').trim();

    if(!roomCode){ socket.emit('error', 'Room code missing'); return; }
    if(!cleanName){ socket.emit('error', 'Player name missing'); return; }

    const room = rooms.get(roomCode);
    if(!room){ socket.emit('error', 'Room not found. The host may need to create a new room if the server restarted.'); return; }

    // Rejoin support: prefer the private player token, then fall back to exact player name.
    let existingIdx = -1;
    if(cleanToken){
      existingIdx = room.players.findIndex(p => p.token && p.token === cleanToken);
    }
    if(existingIdx === -1){
      existingIdx = room.players.findIndex(p =>
        String(p.name || '').trim().toLowerCase() === cleanName.toLowerCase()
      );
    }

    if(room.game && existingIdx !== -1){
      room.players[existingIdx].socketId = socket.id;
      if (room.dcTimers && room.dcTimers[room.players[existingIdx].token]) {
        clearTimeout(room.dcTimers[room.players[existingIdx].token]);
        delete room.dcTimers[room.players[existingIdx].token];
      }
      io.to(roomCode).emit('player_reconnected', { name: room.players[existingIdx].name });
      socket.join(roomCode);

      socket.emit('room_joined', {
        code: roomCode,
        room: sanitiseRoom(room),
        isHost: !!room.players[existingIdx].isHost,
        rejoined: true,
        playerToken: room.players[existingIdx].token,
      });

      io.to(roomCode).emit('room_updated', sanitiseRoom(room));
      socket.emit('game_state', playerView(room.game, existingIdx));
      socket.emit('action_error', 'Rejoined game successfully.');
      io.to(roomCode).emit('system_message', { text: `✅ ${room.players[existingIdx].name} rejoined the game`, ts: Date.now() });
      return;
    }

    // If a game is running and this is not one of the original players, block it.
    if(room.game){ socket.emit('error', 'Game already in progress'); return; }

    // Before the game starts, prevent duplicate names causing rejoin confusion later.
    if(existingIdx !== -1){ socket.emit('error', 'That player name is already in this room'); return; }

    if(room.players.length >= 4){ socket.emit('error', 'Room is full (max 4)'); return; }

    const newPlayer = { socketId: socket.id, name: cleanName, isHost: false, token: genToken() };
    room.players.push(newPlayer);
    socket.join(roomCode);
    io.to(roomCode).emit('room_updated', sanitiseRoom(room));
    socket.emit('room_joined', { code: roomCode, room: sanitiseRoom(room), isHost: false, playerToken: newPlayer.token });
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms.get(code);
    if(!room) return;
    const rp = room.players.find(p => p.socketId === socket.id);
    if(!rp?.isHost) return;
    if(room.players.length < 2){ socket.emit('error', 'Need at least 2 players'); return; }
    room.game = initGame(room.players.map(p => ({ name: p.name })), 0);
    room.lastWinner = null;
    io.to(code).emit('deal_start', { playerNames: room.players.map(p => p.name) });
    setTimeout(() => broadcastGame(code, room.game), 4000);
  });

  // Any player can trigger next round
  socket.on('next_round', ({ code }) => {
    const room = rooms.get(code);
    if(!room) return;
    const rp = room.players.find(p => p.socketId === socket.id);
    if(!rp) return;
    const startPlayer = room.lastWinner ?? 0;
    room.game = initGame(room.players.map(p => ({ name: p.name })), startPlayer);
    io.to(code).emit('deal_start', { playerNames: room.players.map(p => p.name), startPlayer });
    setTimeout(() => broadcastGame(code, room.game), 4000);
  });

  socket.on('game_action', ({ code, action, payload }) => {
    const room = rooms.get(code);
    if(!room?.game) return;
    const myIdx = room.players.findIndex(p => p.socketId === socket.id);
    if(myIdx !== room.game.currentPlayer){ socket.emit('action_error', 'It is not your turn yet.'); return; }

    const fail = msg => { socket.emit('action_error', msg); return null; };
    let g = { ...room.game };

    try {
      if(action === 'draw_deck'){
        if(g.phase !== 'draw') return fail('You must throw before drawing again.');
        let {deck,discardPile,tableSets} = g;
        if(!deck.length && discardPile.length > 1){const top=discardPile.pop();deck=shuffle([...discardPile]);discardPile=[top];}
        else if(!deck.length && !discardPile.length){const r=reshuffleTableSets(deck,discardPile,tableSets,g.wildRank);deck=r.deck;discardPile=r.disc;tableSets=r.sets;}
        if(!deck.length) return fail('No cards available to draw.');
        const players=g.players.map(p=>({...p,hand:[...p.hand]}));
        players[myIdx].hand.push(deck[deck.length-1]);
        g=appendMove({...g,players,deck:deck.slice(0,-1),discardPile,tableSets,phase:'play'}, players[myIdx].name + ' picked up from deck');
      }

      else if(action === 'draw_discard'){
        if(g.phase !== 'draw' || !g.discardPile.length) return fail('No throw card available to pick up.');
        const players=g.players.map(p=>({...p,hand:[...p.hand]}));
        const card=g.discardPile[g.discardPile.length-1];
        players[myIdx].hand.push(card);
        g=appendMove({...g,players,discardPile:g.discardPile.slice(0,-1),phase:'play'}, players[myIdx].name + ' picked up the throw');
      }

      else if(action === 'play_set'){
        if(g.phase !== 'play') return fail('Pick up a card first.');
        const {cardIds} = payload;
        const players=g.players.map(p=>({...p,hand:[...p.hand]}));
        const hand=players[myIdx].hand;
        const cards=cardIds.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
        if(!validMeld(cards)) return fail('That is not a valid set. Check the order and suits.');
        if(!players[myIdx].hasComDown && cards.length < 4) return fail('First set must be 4 or more cards.');
        // Suit duplicate check
        const existingSuits=suitsOnTable(g.tableSets);
        if(isDonutSet(cards)){
          if(!canPlayDonkeySet(g.tableSets,cards)) return fail('Donkey set needs all 4 suits represented. Jokers can fill missing suits.');
        } else {
          const newSuit=getRunSuit(cards);
          if(newSuit && existingSuits.has(newSuit)) return fail('A ' + newSuit + ' set is already on the table.');
        }
        players[myIdx].hand=hand.filter(c=>!cardIds.includes(c.id));
        if(!players[myIdx].hasComDown) players[myIdx].hasComDown=true;
        const sets=[...g.tableSets,{playerId:myIdx,playerName:players[myIdx].name,cards}];
        const won=!players[myIdx].hand.length;
        if(won) room.lastWinner=myIdx;
        g=appendMove({...g,players,tableSets:sets,winner:won?myIdx:null,wildWin:won&&cards.some(c=>c.isWild)}, players[myIdx].name + ' played a set');
      }

      else if(action === 'play_two_sets'){
        if(g.phase !== 'play') return fail('Pick up a card first.');
        const {set1Ids, set2Ids} = payload;
        const players=g.players.map(p=>({...p,hand:[...p.hand]}));
        const hand=players[myIdx].hand;
        const s1=set1Ids.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
        const s2=set2Ids.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
        if(!validMeld(s1)||!validMeld(s2)||s1.length<4) return fail('Double come-down needs a valid 4+ set and valid 3+ set.');
        // Suit duplicate check for both sets
        const existingSuits=suitsOnTable(g.tableSets);
        for(const cards of [s1,s2]){
          if(isDonutSet(cards)){if(!canPlayDonkeySet(g.tableSets,cards))return fail('Donkey set needs all 4 suits represented. Jokers can fill missing suits.');}
          else{const ns=getRunSuit(cards);if(ns&&existingSuits.has(ns))return fail('A ' + ns + ' set is already on the table.');}
        }
        const allIds=new Set([...set1Ids,...set2Ids]);
        players[myIdx].hand=hand.filter(c=>!allIds.has(c.id));
        players[myIdx].hasComDown=true;
        const sets=[...g.tableSets,{playerId:myIdx,playerName:players[myIdx].name,cards:s1},{playerId:myIdx,playerName:players[myIdx].name,cards:s2}];
        const won=!players[myIdx].hand.length;
        if(won) room.lastWinner=myIdx;
        g=appendMove({...g,players,tableSets:sets,winner:won?myIdx:null,wildWin:won&&[...s1,...s2].some(c=>c.isWild)}, players[myIdx].name + ' played two sets');
      }

      else if(action === 'add_to_set'){
        if(g.phase !== 'play') return fail('Pick up a card first.');
        if(!g.players[myIdx].hasComDown) return fail('Come down first before adding to a set.');
        const {cardId, setIdx, type, wildId} = payload;
        const players=g.players.map(p=>({...p,hand:[...p.hand]}));
        const sc=players[myIdx].hand.find(c=>c.id===cardId);
        if(!sc) return fail('Select one card to add.');
        const tc=g.tableSets[setIdx].cards;
        let nc, wb=null;
        if(type==='wild'){wb=tc.find(c=>c.id===wildId);nc=tc.map(c=>c.id===wildId?sc:c);}
        else if(type==='start') nc=[sc,...tc];
        else nc=[...tc,sc];
        if(!validMeld(nc)) return fail('That card cannot be placed there.');
        players[myIdx].hand=players[myIdx].hand.filter(c=>c.id!==cardId);
        if(wb) players[myIdx].hand.push({...wb,isWild:true});
        const sets=g.tableSets.map((s,i)=>i===setIdx?{...s,cards:nc}:s);
        const won=!players[myIdx].hand.length;
        if(won) room.lastWinner=myIdx;
        g=appendMove({...g,players,tableSets:sets,winner:won?myIdx:null,wildWin:won&&(sc.isWild||wb!==null)}, players[myIdx].name + ' added to a set');
      }

      else if(action === 'discard'){
        if(g.phase !== 'play') return fail('Pick up first, then throw to end your turn.');
        const {cardId} = payload;
        const players=g.players.map(p=>({...p,hand:[...p.hand]}));
        const card=players[myIdx].hand.find(c=>c.id===cardId);
        if(!card) return fail('Select exactly one card to throw.');
        players[myIdx].hand=players[myIdx].hand.filter(c=>c.id!==cardId);
        const dp=[...g.discardPile,card];
        if(!players[myIdx].hand.length){
          room.lastWinner=myIdx;
          g=appendMove({...g,players,discardPile:dp,winner:myIdx,wildWin:card.isWild}, players[myIdx].name + ' threw and went out');
        }
        else if(card.isWild){
          g=appendMove({...g,players,discardPile:dp,phase:'recall',recallBy:myIdx,recallCard:card.id}, players[myIdx].name + ' threw a Joker/Wild — 5 seconds to recall!');
          room.game = g;
          broadcastGame(code, g);
          setTimeout(() => {
            const r = rooms.get(code);
            if(!r?.game || r.game.phase !== 'recall' || r.game.recallBy !== myIdx) return;
            let nd=r.game.deck, fd=[...r.game.discardPile];
            if(!nd.length&&fd.length>1){const top=fd.pop();nd=shuffle([...fd]);fd=[top];}
            const next=(myIdx+1)%r.game.players.length;
            r.game=appendMove({...r.game,deck:nd,discardPile:fd,currentPlayer:next,phase:'draw',recallBy:null,recallCard:null}, 'Recall window closed. Next player may pick up the throw.');
            broadcastGame(code, r.game);
          }, 5000);
          return;
        }
        else{
          let nd=g.deck,fd=dp;
          if(!nd.length&&dp.length>1){const top=dp.pop();nd=shuffle([...dp]);fd=[top];}
          const next=(g.currentPlayer+1)%g.players.length;
          g=appendMove({...g,players,deck:nd,discardPile:fd,currentPlayer:next,phase:'draw'}, players[myIdx].name + ' threw ' + card.rank + (card.suit!=='★'?card.suit:'🃏'));
        }
      }

      else if(action === 'recall_wild'){
        if(g.phase !== 'recall' || g.recallBy !== myIdx) return fail('Cannot recall now.');
        const players=g.players.map(p=>({...p,hand:[...p.hand]}));
        const card=g.discardPile[g.discardPile.length-1];
        if(!card || !card.isWild) return fail('No Joker/Wild to recall.');
        players[myIdx].hand.push(card);
        const dp=g.discardPile.slice(0,-1);
        g=appendMove({...g,players,discardPile:dp,phase:'play',recallBy:null,recallCard:null}, players[myIdx].name + ' recalled the Joker/Wild');
      }

      room.game = g;

      // AI auto-play after a short delay if next player is CPU
      if(g.winner === null){
        const nextP = room.players[g.currentPlayer];
        if(!nextP){ // CPU slot (no socket)
          setTimeout(() => {
            if(!rooms.has(code)) return;
            let gg = rooms.get(code).game;
            let guard = 0;
            while(gg && gg.winner === null && !rooms.get(code)?.players[gg.currentPlayer] && guard++<20){
              gg = runAiTurn(gg);
            }
            if(gg){ rooms.get(code).game = gg; broadcastGame(code, gg); }
          }, 900);
        }
      }

      broadcastGame(code, g);
    } catch(e){ console.error('action error', e); }
  });

  // Player ready
  socket.on('player_ready', ({ code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return;
    const p = room.players.find(p => p.socketId === socket.id);
    if (p) { p.ready = true; io.to(code.toUpperCase()).emit('room_updated', { room: sanitiseRoom(room) }); }
  });

  // Host sets card theme
  socket.on('set_theme', ({ code, theme }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return;
    room.theme = theme;
    io.to(code.toUpperCase()).emit('theme_changed', { theme });
  });

  // Rematch — reset scores, keep same players, start new series
  socket.on('rematch', ({ code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room || !room.game) return;
    const myIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (myIdx !== 0) return; // only host can trigger
    // Reset player stats but keep names
    room.players.forEach(p => { p.ready = false; p.wins = 0; p.total = 0; });
    room.game = null;
    io.to(code.toUpperCase()).emit('room_updated', { room: sanitiseRoom(room) });
    // Trigger a fresh deal
    const g = dealGame(room.players.map((p,i) => ({ id: i, name: p.name, isAI: false })));
    room.game = g;
    room.players.forEach((p, i) => io.to(p.socketId).emit('deal_start', { playerNames: room.players.map(p => p.name) }));
    setTimeout(() => { room.players.forEach((_, i) => { if(room.game) io.to(room.players[i].socketId).emit('game_state', playerView(room.game, i)); }); }, 800);
  });

  // Chat
  function handleChat({ code, playerName, message }) {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    const text = String(message || '').trim().slice(0, 200);
    if (!room || !text) return;
    const sender = room.players.find(p => p.socketId === socket.id);
    const safeName = sender?.name || String(playerName || 'Player').trim().slice(0, 16) || 'Player';
    const msg = { playerName: safeName, message: text, timestamp: Date.now() };
    io.to(roomCode).emit('chat_message', msg);
  }
  socket.on('chat_message', handleChat);

  // Save series to recent games when End Game is clicked
  socket.on('end_game', ({ code, series, playerName }) => {
    if (!series || !series.players || !series.players.length) return;
    const sorted = [...series.players]
      .map(p => ({ name: p.name, total: p.total || 0, wins: p.wins || 0 }))
      .sort((a, b) => a.total - b.total);
    recentGames.unshift({
      date: new Date().toISOString(),
      rounds: series.round || 0,
      players: sorted,
      participants: sorted.map(p => p.name),
      endedBy: playerName || null,
      winner: sorted[0]?.name || "Unknown",
    });
    if (recentGames.length > 5) recentGames.pop();
  });

  // Rejoin a room after disconnect
  socket.on('rejoin_room', ({ code, playerName, playerToken }) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const cleanName = String(playerName || '').trim().toLowerCase();
    const cleanToken = String(playerToken || '').trim();
    const room = rooms.get(roomCode);

    if (!room || !room.game) {
      socket.emit('error', 'Room not found or game not started. The host may need to create a new room if the server restarted.');
      return;
    }

    let idx = -1;
    if(cleanToken){
      idx = room.players.findIndex(p => p.token && p.token === cleanToken);
    }
    if(idx === -1){
      idx = room.players.findIndex(p => String(p.name || '').trim().toLowerCase() === cleanName);
    }
    if (idx === -1) { socket.emit('error', 'Player not found in this room'); return; }

    room.players[idx].socketId = socket.id;
    if (room.dcTimers && room.dcTimers[room.players[idx].token]) {
      clearTimeout(room.dcTimers[room.players[idx].token]);
      delete room.dcTimers[room.players[idx].token];
    }
    socket.join(roomCode);
    socket.emit('room_joined', { code: roomCode, room: sanitiseRoom(room), isHost: room.players[idx].isHost, rejoined: true, playerToken: room.players[idx].token });
    io.to(roomCode).emit('player_reconnected', { name: room.players[idx].name });
    io.to(roomCode).emit('room_updated', { room: sanitiseRoom(room) });
    socket.emit('game_state', playerView(room.game, idx));
    socket.emit('action_error', 'Rejoined game successfully.');
    io.to(roomCode).emit('system_message', { text: `✅ ${room.players[idx].name} rejoined the game`, ts: Date.now() });
  });

  // Resend the current game state to the requesting socket only (no broadcasts,
  // no chat messages). The game screen calls this on mount so a rejoining player
  // isn't left on "Connecting…" if the state arrived while still on the lobby.
  socket.on('request_state', ({ code }) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room || !room.game) return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1) return;
    socket.emit('game_state', playerView(room.game, idx));
  });

  socket.on('player_exit', ({ code }) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if(!room) return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if(idx === -1) return;
    room.players[idx].socketId = null;
    io.to(roomCode).emit('system_message', { text: `⚠️ ${room.players[idx].name} left the game`, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    console.log('- disconnected', socket.id);
    rooms.forEach((room, code) => {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if(idx === -1) return;
      if(!room.game){
        room.players.splice(idx, 1);
        if(!room.players.length){ rooms.delete(code); return; }
        if(idx===0 && room.players.length) room.players[0].isHost=true;
        io.to(code).emit('room_updated', sanitiseRoom(room));
      } else {
        // Mid-game disconnect: hold the seat, give 30s to rejoin, then end the game for everyone.
        const player = room.players[idx];
        player.socketId = null;
        const GRACE_SECONDS = 30;
        io.to(code).emit('player_disconnected', { name: player.name, seconds: GRACE_SECONDS });
        io.to(code).emit('system_message', { text: `⚠️ ${player.name} disconnected — ${GRACE_SECONDS}s to rejoin…`, ts: Date.now() });
        room.dcTimers = room.dcTimers || {};
        if (room.dcTimers[player.token]) clearTimeout(room.dcTimers[player.token]);
        room.dcTimers[player.token] = setTimeout(() => {
          const r = rooms.get(code);
          if (!r) return;
          const p = r.players.find(pp => pp.token === player.token);
          if (p && !p.socketId) {
            io.to(code).emit('game_over', { reason: `${player.name} did not reconnect in time.` });
            io.to(code).emit('system_message', { text: `🏁 Game ended — ${player.name} did not reconnect.`, ts: Date.now() });
            rooms.delete(code);
          }
        }, GRACE_SECONDS * 1000);
      }
    });
  });
});

function sanitiseRoom(room){
  return { code: room.code, players: room.players.map(p=>({name:p.name,isHost:p.isHost,ready:p.ready||false,socketId:p.socketId})) };
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🃏 Shiv's 9 Card server v1.0.7 running on port ${PORT}`);
  // Keep Railway alive — ping every 9 minutes
  const BASE = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  setInterval(() => { fetch(BASE + '/health').catch(() => {}); }, 9 * 60 * 1000);
});

