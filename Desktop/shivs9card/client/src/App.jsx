import React, { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const APP_VERSION = "v1.2.0";
const ONLINE_BASE_URL = "https://shivs9card-production.up.railway.app";
const API_BASE_URL = (typeof window !== "undefined" && (window.location.protocol === "capacitor:" || window.location.hostname === "localhost")) ? ONLINE_BASE_URL : "";

// ─── Responsive card sizes ────────────────────────────────────
function useCardSizes() {
  const [vw, setVw] = useState(window.innerWidth);
  useEffect(() => {
    const h = () => setVw(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const W  = Math.min(54, Math.max(36, Math.floor(vw / 7.5)));
  const H  = Math.round(W * 1.41);
  const Ws = Math.min(38, Math.max(26, Math.floor(vw / 11)));
  const Hs = Math.round(Ws * 1.41);
  return { W, H, Ws, Hs };
}

// ─── Constants ───────────────────────────────────────────────
const SUITS = ["♠","♥","♦","♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const RV = {A:1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,J:11,Q:12,K:13};

function rv(r, hi = false) { return r === "A" ? (hi ? 14 : 1) : (RV[r] || 0); }
function nextRank(r) { return r === "JOKER" ? null : RANKS[(RANKS.indexOf(r) + 1) % RANKS.length]; }
function isRed(s) { return s === "♥" || s === "♦"; }
function suitColor(s) { return isRed(s) ? "#dc2626" : "#1e293b"; }

let uid = 0;

// ─── Deck ────────────────────────────────────────────────────
function makeDeck() {
  uid = 0;
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: uid++, isWild: false });
  d.push({ suit: "★", rank: "JOKER", id: uid++, isWild: true });
  d.push({ suit: "★", rank: "JOKER", id: uid++, isWild: true });
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function markWilds(cards, wr) {
  return cards.map(c => ({ ...c, isWild: c.rank === "JOKER" || c.rank === wr }));
}

// ─── Meld validation ─────────────────────────────────────────
function isDonutSet(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const nw = cards.filter(c => !c.isWild);
  if (!nw.length) return false;
  const rank = nw[0].rank;
  if (!nw.every(c => c.rank === rank)) return false;
  const suits = new Set(nw.map(c => c.suit));
  if (suits.size !== nw.length) return false;            // real suits must all differ
  const wildCount = cards.filter(c => c.isWild).length;
  return suits.size + wildCount >= 4;                     // a donkey set must cover all 4 shapes
}
function getRunSuit(cards) {
  const nw = cards.filter(c => !c.isWild);
  if (!nw.length) return null;
  const suit = nw[0].suit;
  return nw.every(c => c.suit === suit) ? suit : null;
}
function suitsOnTable(tableSets) {
  const s = new Set();
  for (const ts of tableSets) { const rs = getRunSuit(ts.cards); if (rs) s.add(rs); }
  return s;
}

function validMeld(cards) {
  if (cards.length < 3) return false;
  const wilds = cards.filter(c => c.isWild);
  const nw = cards.filter(c => !c.isWild);
  if (!nw.length) return false;
  // Donkey set: same rank, all different suits
  if (isDonutSet(cards)) return true;
  // Suit run — A needs at least one other real card to anchor which end it sits on.
  // A alone with jokers (e.g. Joker A Joker) is ambiguous: it could be A-2-3 or Q-K-A.
  if (nw.length === 1 && nw[0].rank === "A") return false;
  // Suit run
  const suit = nw[0].suit;
  if (nw.some(c => c.suit !== suit)) return false;
  for (const hi of [false, true]) {
    const vals = nw.map(c => rv(c.rank, hi)).sort((a, b) => a - b);
    if (new Set(vals).size !== vals.length) continue;
    const span = vals[vals.length - 1] - vals[0] + 1;
    const gaps = span - nw.length;
    if (gaps <= wilds.length) {
      const extra = wilds.length - gaps;
      for (let s = Math.max(1, vals[0] - extra); s <= vals[0]; s++) {
        if (s + cards.length - 1 <= 14) return true;
      }
    }
  }
  return false;
}

function canAdd(existing, card) { return validMeld([...existing, card]); }

// ─── Sort meld for display ────────────────────────────────────
function sortMeld(cards) {
  const wilds = cards.filter(c => c.isWild);
  const nw = cards.filter(c => !c.isWild);
  if (!nw.length) return wilds.map((c, i) => ({ card: c, val: i, rk: "?", disp: "?", isWild: true, suit: "?" }));
  const suit = nw[0].suit;

  // Donkey set: keep the exact played order. Jokers display as the real rank.
  if (isDonutSet(cards)) {
    const rank = nw[0].rank;
    return cards.map((c, i) => ({
      card: c,
      val: rv(rank),
      rk: c.isWild ? rank : c.rank,
      disp: (c.isWild ? rank : c.rank) + (c.suit !== "★" ? c.suit : "🃏"),
      isWild: c.isWild,
      suit: c.suit,
      order: i,
    }));
  }

  // First try to interpret the run using the exact order the player selected/placed cards.
  // This means Joker,J,Q,K displays as 10,J,Q,K; J,Q,K,Joker displays as J,Q,K,A.
  function tryOrdered(hi) {
    if (nw.some(c => c.suit !== suit)) return null;
    const fixed = cards.map((c, i) => c.isWild ? null : rv(c.rank, hi));
    for (let start = 1; start <= 14 - cards.length + 1; start++) {
      let ok = true;
      for (let i = 0; i < cards.length; i++) {
        if (fixed[i] !== null && fixed[i] !== start + i) { ok = false; break; }
      }
      if (!ok) continue;
      return cards.map((c, i) => {
        const val = start + i;
        const dr = val === 14 ? "A" : RANKS[val - 1];
        return {
          card: c,
          val,
          rk: c.isWild ? dr : c.rank,
          disp: (c.isWild ? dr : c.rank) + suit,
          isWild: c.isWild,
          suit,
          order: i,
        };
      });
    }
    return null;
  }
  for (const hi of [false, true]) {
    const ordered = tryOrdered(hi);
    if (ordered) return ordered;
  }

  function tryBuild(sorted, hi, start) {
    const end = start + cards.length - 1;
    if (start < 1 || end > 14) return null;
    const result = [], used = new Set();
    let wi = 0;
    for (let pos = start; pos <= end; pos++) {
      const c = sorted.find(x => !used.has(x.id) && rv(x.rank, hi) === pos);
      if (c) {
        used.add(c.id);
        result.push({ card: c, val: pos, rk: c.rank, disp: c.rank + suit, isWild: false, suit });
      } else {
        if (wi >= wilds.length) return null;
        const dr = pos === 14 ? "A" : RANKS[pos - 1];
        result.push({ card: wilds[wi++], val: pos, rk: dr, disp: dr + suit, isWild: true, suit });
      }
    }
    return wi === wilds.length ? result : null;
  }

  for (const hi of [false, true]) {
    const sorted = [...nw].sort((a, b) => rv(a.rank, hi) - rv(b.rank, hi));
    const vals = sorted.map(c => rv(c.rank, hi));
    if (new Set(vals).size !== vals.length) continue;
    const min = vals[0], span = vals[vals.length - 1] - min + 1, gaps = span - nw.length;
    if (gaps > wilds.length) continue;
    const extra = wilds.length - gaps;
    const wildLeads = cards[0]?.isWild;
    const result = wildLeads
      ? (tryBuild(sorted, hi, min - extra) || tryBuild(sorted, hi, min))
      : (tryBuild(sorted, hi, min)         || tryBuild(sorted, hi, min - extra));
    if (result) return result;
  }
  const fb = [...nw].sort((a, b) => rv(a.rank) - rv(b.rank)).map(c => ({ card: c, val: rv(c.rank), rk: c.rank, disp: c.rank + suit, isWild: false, suit }));
  wilds.forEach(c => fb.push({ card: c, val: 0, rk: "?", disp: "?", isWild: true, suit }));
  return fb;
}

function canPlayDonkeySet(tableSets, cards) {
  if (!isDonutSet(cards)) return false;
  const represented = suitsOnTable(tableSets);
  cards.filter(c => !c.isWild && SUITS.includes(c.suit)).forEach(c => represented.add(c.suit));
  const wildCount = cards.filter(c => c.isWild).length;
  return represented.size + wildCount >= 4;
}

// ─── Scoring ─────────────────────────────────────────────────
function cardPoints(card) {
  if (card.isWild) return 30;
  if (["J","Q","K"].includes(card.rank)) return 10;
  if (card.rank === "A") return 11;
  return parseInt(card.rank) || 0;
}

function scorePlayer(player) {
  if (!player.hand.length) return { total: 0, noSet: false, items: [] };
  const items = [];
  let total = 0;
  if (!player.hasComDown) { items.push({ label: "No set played", pts: 30 }); total += 30; }
  for (const c of player.hand) {
    const pts = cardPoints(c);
    items.push({ label: c.rank + (c.suit !== "★" ? c.suit : "🃏"), pts });
    total += pts;
  }
  return { total, noSet: !player.hasComDown, items };
}

// Reshuffle table sets back into deck when deck + discard are both empty
function reshuffleTableSets(deck, discardPile, tableSets, wildRank) {
  if (deck.length || discardPile.length) return { deck, discardPile, tableSets };
  // Pull all cards from all table sets back into a new deck
  const recovered = [];
  tableSets.forEach(s => s.cards.forEach(c => recovered.push(c)));
  if (!recovered.length) return { deck, discardPile, tableSets };
  const newDeck = markWilds(shuffle(recovered), wildRank);
  return { deck: newDeck, discardPile: [], tableSets: [] };
}

// ─── Series ──────────────────────────────────────────────────
function initSeries(n, names = []) {
  return {
    n,
    playerNames: Array.from({ length: n }, (_, i) => names[i] || (i === 0 ? "You" : "CPU " + i)),
    players: Array.from({ length: n }, (_, i) => ({
      id: i, name: names[i] || (i === 0 ? "You" : "CPU " + i),
      isAI: i !== 0, total: 0, wins: 0, consec: 0,
    })),
    round: 0,
    lastWin: null,
  };
}

// Build meaningful round-summary highlights from reliable per-player points.
// (Replaces the old fastestWin/mostSets/comeback blocks, which mislabelled
//  leftover-card counts as "sets" and the worst score as a "comeback".)
function buildRoundStats(players, winnerId) {
  const winner = players.find(p => p.id === winnerId);
  const losers = players.filter(p => p.id !== winnerId)
    .sort((a, b) => (a.lastPts || 0) - (b.lastPts || 0));
  const closest = losers[0];
  const heaviest = losers[losers.length - 1];
  return {
    winnerName: winner ? winner.name : null,
    // "Closest" only makes sense with 2+ losers (otherwise it's the same player as heaviest)
    closest: losers.length >= 2 && closest ? `${closest.name} (+${closest.lastPts || 0})` : null,
    heaviest: heaviest && (heaviest.lastPts || 0) > 0 ? `${heaviest.name} (+${heaviest.lastPts || 0})` : null,
  };
}

function applySeries(series, winnerId, gamePlayers, wildWin = false) {
  const scores = gamePlayers.map(p => ({ id: p.id, ...scorePlayer(p) }));
  const players = series.players.map(sp => {
    const rs = scores.find(r => r.id === sp.id);
    const won = sp.id === winnerId;
    const gp = gamePlayers.find(p => p.id === sp.id);

    if (won && wildWin) {
      let consec = sp.consec + 1;
      let bonus = 0;
      if (consec >= 3) { bonus = -50; consec = 0; }
      return {
        ...sp, total: sp.total + 30 + bonus, wins: sp.wins + 1, consec,
        lastPts: 30, lastItems: [{ label: "Won with Joker/Wild", pts: 30 }],
        lastBonus: bonus, lastNoSet: false, lastWildWin: true, lastHand: gp?.hand || [],
      };
    }

    const pts = rs ? rs.total : 0;
    let consec = won ? sp.consec + 1 : 0;
    let bonus = 0;
    if (consec >= 3) { bonus = -50; consec = 0; }
    return {
      ...sp, total: sp.total + pts + bonus,
      wins: sp.wins + (won ? 1 : 0), consec,
      lastPts: pts, lastItems: rs ? rs.items : [],
      lastBonus: bonus, lastNoSet: rs ? rs.noSet : false,
      lastWildWin: false, lastHand: gp?.hand || [],
    };
  });
  const roundStats = buildRoundStats(players, winnerId);
  return { ...series, players, round: series.round + 1, lastWin: winnerId, roundStats };
}

// ─── Series helper for online (uses server scores directly) ─────
function applySeriesFromServer(series, winnerId, gamePlayers, wildWin = false) {
  const players = series.players.map(sp => {
    const gp = gamePlayers.find(p => p.id === sp.id);
    const won = sp.id === winnerId;
    const pts = gp ? (gp._serverTotal ?? (won && wildWin ? 30 : 0)) : (won && wildWin ? 30 : 0);
    let consec = won ? sp.consec + 1 : 0;
    let bonus = 0;
    if (consec >= 3) { bonus = -50; consec = 0; }
    return {
      ...sp,
      total: sp.total + pts + bonus,
      wins: sp.wins + (won ? 1 : 0),
      consec,
      lastPts: pts,
      lastItems: gp?._serverItems?.length ? gp._serverItems : (won && wildWin ? [{ label: "Won with Joker/Wild", pts: 30 }] : []),
      lastBonus: bonus,
      lastNoSet: gp?._serverNoSet || false,
      lastWildWin: won && wildWin,
      lastHand: (won && wildWin) ? [] : (gp?.hand || []),
    };
  });
  const roundStats = buildRoundStats(players, winnerId);
  return { ...series, players, round: series.round + 1, lastWin: winnerId, roundStats };
}

// ─── Multi-meld come-down helper ─────────────────────────────
// Returns [meld1(4+), meld2(3+)] if the selection can be split, else null
function findTwoMelds(cards) {
  if (cards.length < 7) return null;
  // Try greedy: find best 4+ meld, then best 3+ meld from remainder
  const first = findBestMeld(cards, 4);
  if (!first) return null;
  const firstIds = new Set(first.map(c => c.id));
  const rest = cards.filter(c => !firstIds.has(c.id));
  const second = findBestMeld(rest, 3);
  if (!second) return null;
  return [first, second];
}

// ─── AI ──────────────────────────────────────────────────────
function findBestMeld(hand, minLen) {
  const wilds = hand.filter(c => c.isWild);
  const nw = hand.filter(c => !c.isWild);
  let best = null;
  for (const suit of SUITS) {
    for (const hi of [false, true]) {
      const sc = nw.filter(c => c.suit === suit).map(c => ({ ...c, v: rv(c.rank, hi) })).sort((a, b) => a.v - b.v);
      for (let i = 0; i < sc.length; i++) {
        for (let j = i; j < sc.length; j++) {
          const sl = sc.slice(i, j + 1);
          const vals = sl.map(c => c.v);
          if (new Set(vals).size !== vals.length) continue;
          const span = vals[vals.length - 1] - vals[0] + 1;
          const gaps = span - sl.length;
          for (let w = gaps; w <= wilds.length; w++) {
            const meld = [...sl, ...wilds.slice(0, w)];
            if (meld.length >= minLen && validMeld(meld) && (!best || meld.length > best.length)) best = meld;
          }
        }
      }
    }
  }
  return best;
}

function findAddToSet(hand, tableSets) {
  for (const card of hand) {
    for (let i = 0; i < tableSets.length; i++) {
      if (canAdd(tableSets[i].cards, card)) return { card, idx: i };
    }
  }
  return null;
}

function pickDiscard(hand) {
  const nw = hand.filter(c => !c.isWild);
  if (!nw.length) return hand[0];
  return nw.reduce((worst, c) => {
    const cs = nw.filter(x => x.suit === c.suit && Math.abs(rv(x.rank) - rv(c.rank)) <= 3).length;
    const ws = nw.filter(x => x.suit === worst.suit && Math.abs(rv(x.rank) - rv(worst.rank)) <= 3).length;
    return cs < ws ? c : worst;
  });
}

function runAiTurn(game) {
  const players = game.players.map(p => ({ ...p, hand: [...p.hand] }));
  let deck = [...game.deck];
  let discardPile = [...game.discardPile];
  let tableSets = game.tableSets.map(s => ({ ...s, cards: [...s.cards] }));
  const cur = game.currentPlayer;
  const p = players[cur];
  const acts = [];

  // Draw — pick up discard if useful, else deck, else reshuffle table sets
  const topDisc = discardPile[discardPile.length - 1];
  const shouldPickupDiscard = topDisc && !topDisc.isWild && (() => {
    const testHand = [...p.hand, topDisc];
    return !!(findBestMeld(testHand, p.hasComDown ? 3 : 4) || findAddToSet([topDisc], tableSets));
  })();
  if (shouldPickupDiscard) {
    p.hand.push(discardPile.pop());
  } else if (deck.length) {
    p.hand.push(deck.pop());
  } else if (discardPile.length) {
    p.hand.push(discardPile.pop());
  } else {
    // Both empty — reshuffle table sets back into deck
    const reshuffled = reshuffleTableSets(deck, discardPile, tableSets, game.wildRank);
    deck = reshuffled.deck; discardPile = reshuffled.discardPile; tableSets = reshuffled.tableSets;
    if (deck.length) p.hand.push(deck.pop());
  }

  // Come down — try 4+ single meld, or 4++3+ double meld
  if (!p.hasComDown) {
    // Helper: check if a meld is allowed given current table suits
    const meldAllowed = (m) => {
      const es = suitsOnTable(tableSets);
      if (isDonutSet(m)) return es.size >= 4;
      const ms = getRunSuit(m);
      return !ms || !es.has(ms);
    };

    // Try double come-down first (4+ and 3+)
    const twoMelds = findTwoMelds(p.hand);
    if (twoMelds && twoMelds.every(m => meldAllowed(m))) {
      for (const m of twoMelds) {
        const ids = new Set(m.map(c => c.id));
        p.hand = p.hand.filter(c => !ids.has(c.id));
        tableSets.push({ playerId: p.id, playerName: p.name, cards: m });
        acts.push("came down " + m.length);
        if (!p.hand.length) return { ...game, players, tableSets, winner: p.id, wildWin: twoMelds.flat().some(c => c.isWild) };
      }
      p.hasComDown = true;
    } else {
      const m = findBestMeld(p.hand, 4);
      if (m && meldAllowed(m)) {
        const ids = new Set(m.map(c => c.id));
        p.hand = p.hand.filter(c => !ids.has(c.id));
        tableSets.push({ playerId: p.id, playerName: p.name, cards: m });
        p.hasComDown = true;
        acts.push("came down " + m.length);
        if (!p.hand.length) return { ...game, players, tableSets, winner: p.id, wildWin: m.some(c => c.isWild) };
      }
    }
  }

  // Add to sets and play 3+ melds
  if (p.hasComDown) {
    let changed = true, guard = 0;
    while (changed && guard++ < 40) {
      changed = false;
      const r = findAddToSet(p.hand, tableSets);
      if (r) {
        p.hand = p.hand.filter(c => c.id !== r.card.id);
        tableSets[r.idx].cards.push(r.card);
        acts.push("added to set");
        if (!p.hand.length) return { ...game, players, tableSets, winner: p.id, wildWin: r.card.isWild };
        changed = true;
      }
      const m = findBestMeld(p.hand, 3);
      if (m) {
        // Check suit constraint for subsequent sets too
        const es = suitsOnTable(tableSets);
        const allowed = isDonutSet(m) ? es.size >= 4 : (!getRunSuit(m) || !es.has(getRunSuit(m)));
        if (allowed) {
          const ids = new Set(m.map(c => c.id));
          p.hand = p.hand.filter(c => !ids.has(c.id));
          tableSets.push({ playerId: p.id, playerName: p.name, cards: m });
          acts.push("played " + m.length);
          if (!p.hand.length) return { ...game, players, tableSets, winner: p.id, wildWin: m.some(c => c.isWild) };
          changed = true;
        }
      }
    }
  }

  // Discard — detect wild win if last card
  const dc = pickDiscard(p.hand);
  p.hand = p.hand.filter(c => c.id !== dc.id);
  discardPile.push(dc);
  if (!p.hand.length) return { ...game, players, discardPile, tableSets, winner: p.id, wildWin: dc.isWild };

  // Reshuffle discard if deck empty; reshuffle table sets if both empty
  if (!deck.length && discardPile.length > 1) {
    const top = discardPile.pop();
    deck = shuffle([...discardPile]);
    discardPile = [top];
  } else if (!deck.length && !discardPile.length) {
    const reshuffled = reshuffleTableSets(deck, discardPile, tableSets, game.wildRank);
    deck = reshuffled.deck; discardPile = reshuffled.discardPile; tableSets = reshuffled.tableSets;
  }

  const next = (cur + 1) % players.length;
  const summary = acts.length ? p.name + ": " + acts.join(", ") : p.name + " drew & discarded";
  return {
    ...game, players, deck, discardPile, tableSets,
    currentPlayer: next, phase: "draw",
    selectedIds: [], addMode: false, placementIdx: null,
    message: next === 0 ? "🎮 Your turn! (" + summary + ")" : players[next].name + "'s turn...",
  };
}

// ─── Game Init ───────────────────────────────────────────────
function initGame(n, names = []) {
  let deck = shuffle(makeDeck());
  const players = Array.from({ length: n }, (_, i) => ({
    id: i,
    name: names[i] || (i === 0 ? "You" : "CPU " + i),
    isAI: i !== 0,
    hand: [],
    hasComDown: false,
  }));
  for (let c = 0; c < 9; c++) for (const p of players) p.hand.push(deck.pop());
  let flipped = deck.pop();
  while (flipped.rank === "JOKER") { deck.unshift(flipped); flipped = deck.pop(); }
  const wildRank = nextRank(flipped.rank);
  deck = markWilds(deck, wildRank);
  for (const p of players) p.hand = markWilds(p.hand, wildRank);
  return {
    deck, discardPile: [], flipped, wildRank, players,
    currentPlayer: 0, tableSets: [], phase: "draw",
    selectedIds: [], addMode: false, placementIdx: null, wildConfirmed: false,
    message: "🎮 Your turn! Pick Up a card to begin.", winner: null,
  };
}

// ─── Card Component ──────────────────────────────────────────
function CardView({ card, selected, selectedOrder, faceDown, small, onClick, dragging, W: pw, H: ph, Ws: pws, Hs: phs }) {
  const cs = useCardSizes();
  const W = small ? (pws || cs.Ws) : (pw || cs.W);
  const H = small ? (phs || cs.Hs) : (ph || cs.H);
  const isJoker = card && card.rank === "JOKER";
  const col = isJoker ? "#7c3aed" : suitColor(card ? card.suit : "♠");
  return (
    <div onClick={onClick} style={{
      position: "relative", width: W, height: H, flexShrink: 0,
      background: faceDown ? "url(/shivaan.png) center/cover no-repeat, #1b6b3a" : "#fffef2",
      borderRadius: 5,
      border: selected ? "2.5px solid #fbbf24" : dragging ? "2.5px solid #60a5fa" : faceDown ? "1.5px solid #c8b87a" : "1.5px solid #c8b87a",
      cursor: onClick ? "pointer" : "default", userSelect: "none", overflow: "hidden",
      boxShadow: selected ? "0 0 0 3px rgba(251,191,36,0.3),0 8px 18px rgba(0,0,0,0.4)" : "0 2px 8px rgba(0,0,0,0.3)",
      transform: "translateY(" + (selected ? -14 : dragging ? -18 : 0) + "px) scale(" + (dragging ? 1.05 : 1) + ")",
      transition: "transform .15s, box-shadow .15s",
      display: "flex", flexDirection: "column",
    }}>
      {selectedOrder && !faceDown && (
        <div style={{ position: "absolute", top: 2, left: 2, zIndex: 5, width: small ? 14 : 18, height: small ? 14 : 18, borderRadius: "50%", background: "#fbbf24", color: "#111827", fontSize: small ? 8 : 11, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 5px rgba(0,0,0,0.35)" }}>{selectedOrder}</div>
      )}
      {!faceDown && (
        isJoker ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 2, color: col }}>
            <span style={{ fontSize: small ? 16 : 22 }}>🃏</span>
            {!small && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 1 }}>JOKER</span>}
          </div>
        ) : (
          <React.Fragment>
            <div style={{ padding: "2px 3px", fontSize: small ? 8.5 : 10.5, fontWeight: 800, color: col, lineHeight: 1.25 }}>
              {card.rank}<br />{card.suit}
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: small ? 13 : 19, color: col }}>
              {card.suit}
            </div>
            <div style={{ padding: "2px 3px", fontSize: small ? 8.5 : 10.5, fontWeight: 800, color: col, lineHeight: 1.25, transform: "rotate(180deg)", alignSelf: "flex-end" }}>
              {card.rank}<br />{card.suit}
            </div>
            {card.isWild && (
              <div style={{ position: "absolute", top: 0, right: 0, background: "#f59e0b", color: "#fff", fontSize: 7, fontWeight: 800, padding: "1px 3px", borderRadius: "0 4px 0 4px" }}>W</div>
            )}
          </React.Fragment>
        )
      )}
    </div>
  );
}

// ─── Button ──────────────────────────────────────────────────
function Btn({ children, onClick, bg, disabled, active, small }) {
  const bgColor = active ? "#fbbf24" : disabled ? "rgba(255,255,255,0.06)" : (bg || "#374151");
  const textColor = active ? "#1c1c1c" : disabled ? "rgba(255,255,255,0.22)" : "#fff";
  return (
    <button onClick={disabled ? undefined : onClick} style={{
      padding: small ? "5px 10px" : "8px 14px", borderRadius: 8,
      fontSize: small ? 12 : 13, fontWeight: 700,
      background: bgColor, color: textColor,
      border: active ? "2px solid #f59e0b" : "1px solid rgba(255,255,255,0.08)",
      cursor: disabled ? "not-allowed" : "pointer", transition: "all .15s", whiteSpace: "nowrap",
    }}>
      {children}
    </button>
  );
}

// ─── Placement Panel ─────────────────────────────────────────
function PlacementPanel({ meld, selCard, onPlace, onCancel }) {
  const ordered = sortMeld(meld.cards);
  const nwSuit = meld.cards.find(c => !c.isWild) ? meld.cards.find(c => !c.isWild).suit : null;
  const minV = Math.min.apply(null, ordered.map(s => s.val));
  const maxV = Math.max.apply(null, ordered.map(s => s.val));
  const vLo = rv(selCard.rank, false), vHi = rv(selCard.rank, true);
  const suitOk = selCard.isWild || selCard.suit === nwSuit;
  // For wild cards: only show ← ADD if there is actually room to extend LEFT (minV > 1),
  // and only show ADD → if there is room to extend RIGHT (maxV < 14).
  // Without this check validMeld([wild,...set]) returns true even when the wild can only
  // fit at the OTHER end, causing it to always land at the back.
  const canStart = suitOk && validMeld([selCard].concat(meld.cards)) &&
    (selCard.isWild ? minV > 1 : (vLo === minV - 1 || vHi === minV - 1));
  const canEnd   = suitOk && validMeld(meld.cards.concat([selCard])) &&
    (selCard.isWild ? maxV < 14 : (vLo === maxV + 1 || vHi === maxV + 1));

  return (
    <div style={{ background: "rgba(0,0,0,0.55)", borderRadius: 10, padding: "12px 14px", border: "2px solid #fbbf24", marginTop: 8 }}>
      <div style={{ fontSize: 12, marginBottom: 10, opacity: 0.9 }}>
        Place <span style={{ color: "#fbbf24", fontWeight: 700 }}>{selCard.rank}{selCard.suit !== "★" ? selCard.suit : "🃏"}</span> in <strong>{meld.playerName}</strong>'s set:
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
        {canStart && (
          <div onClick={() => onPlace("start", null)}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 38, height: 50, borderRadius: 5, border: "2px dashed #fbbf24", background: "rgba(251,191,36,0.1)", cursor: "pointer", fontSize: 9, color: "#fbbf24", fontWeight: 700, flexShrink: 0 }}>
            ← ADD
          </div>
        )}
        {ordered.map(slot => {
          const canReplace = slot.isWild && validMeld(meld.cards.filter(c => c.id !== slot.card.id).concat([selCard]));
          return (
            <div key={slot.card.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div style={{ position: "relative" }}>
                <CardView card={slot.card} small />
                {slot.isWild && slot.rk !== "?" && (
                  <div style={{
                    position: "absolute", bottom: 2, right: 2,
                    background: "#1e293b", color: "#fbbf24",
                    fontSize: 7, fontWeight: 800, lineHeight: 1.2,
                    padding: "1px 3px", borderRadius: 3,
                    border: "1px solid rgba(251,191,36,0.5)",
                    textAlign: "center", pointerEvents: "none",
                  }}>
                    {slot.rk}<br />{slot.suit === "?" ? "" : slot.suit}
                  </div>
                )}
              </div>
              {slot.isWild && canReplace && (
                <div onClick={() => onPlace("wild", slot.card.id)}
                  style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: "#7c3aed", borderRadius: 4, padding: "2px 6px", cursor: "pointer" }}>
                  Swap↑
                </div>
              )}
            </div>
          );
        })}
        {canEnd && (
          <div onClick={() => onPlace("end", null)}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 38, height: 50, borderRadius: 5, border: "2px dashed #fbbf24", background: "rgba(251,191,36,0.1)", cursor: "pointer", fontSize: 9, color: "#fbbf24", fontWeight: 700, flexShrink: 0 }}>
            ADD →
          </div>
        )}
        {!canStart && !canEnd && !ordered.some(s => s.isWild && validMeld(meld.cards.filter(c => c.id !== s.card.id).concat([selCard]))) && (
          <div style={{ opacity: 0.4, fontSize: 12, fontStyle: "italic" }}>No valid slot for this card</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Btn onClick={onCancel} small>✕ Cancel</Btn>
        {ordered.some(s => s.isWild && validMeld(meld.cards.filter(c => c.id !== s.card.id).concat([selCard]))) && (
          <span style={{ fontSize: 10, opacity: 0.45 }}>Swapping a wild returns it to your hand</span>
        )}
      </div>
    </div>
  );
}

// ─── Funny CPU names ─────────────────────────────────────────
const FUNNY_NAMES = [
  "Wild Willie","Shuffle McGee","Bluff Master","Card Shark Carl",
  "Lucky Louie","Joker Jake","Royal Rupert","High Card Harry",
  "Sneaky Pete","Flush Gordon","King Pin","Ace Ventura",
  "Draw McGraw","Full House Frank","Straight Sam","Count Cardula",
  "Slippery Slim","The Shuffler","Sir Dealsworth","Uno Reverse",
  "Bluffington","Trump Card Tony","Risky Ricky","Sly Foxworth",
  "Wild Wanda","Madame Bluff","Lady Luckystone","Queen of Cons",
];

function pickFunnyCpuNames(count) {
  const pool = [...FUNNY_NAMES].sort(() => Math.random() - 0.5);
  return pool.slice(0, count);
}

// ─── Sound Effects ────────────────────────────────────────────
function playTone(freq, duration, type = "sine", volume = 0.2) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

const Sounds = {
  deal:    () => playTone(380, 0.06, "triangle", 0.12),
  flip:    () => playTone(660, 0.18, "sine",     0.18),
  draw:    () => playTone(440, 0.08, "triangle", 0.12),
  play:    () => playTone(550, 0.12, "sine",     0.20),
  discard: () => playTone(320, 0.08, "sawtooth", 0.10),
  yourTurn:() => playTone(880, 0.30, "sine",     0.22),
  win:     () => [523,659,784,1047].forEach((f,i) => setTimeout(() => playTone(f, 0.35, "sine", 0.28), i * 160)),
};

// ─── CSS keyframe for pulsing glow ────────────────────────────
// Lock portrait mode safely — called from App useEffect, not module level
function lockPortrait() {
  try {
    if (screen?.orientation?.lock) {
      screen.orientation.lock("portrait").catch(() => {});
    } else if (screen?.lockOrientation) {
      screen.lockOrientation("portrait");
    }
  } catch(e) {}
}

// ─── CSS keyframe for pulsing glow ────────────────────────────
// Injected safely from App useEffect, not at module eval time
const SHIV9_STYLES = `
  @keyframes pulseGlow {
    0%,100% { box-shadow: 0 0 0px rgba(251,191,36,0); border-color: rgba(251,191,36,0.3); }
    50%      { box-shadow: 0 0 20px 4px rgba(251,191,36,0.6); border-color: rgba(251,191,36,0.9); }
  }
  .active-player-glow { animation: pulseGlow 1.4s ease-in-out infinite; border: 2px solid rgba(251,191,36,0.3); border-radius: 12px; }
    .deal-flip { transform: none !important; }
`;

// ─── Pulse hook for active player indicator ───────────────────
function usePulse(active) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) { setOn(false); return; }
    const t = setInterval(() => setOn(v => !v), 700);
    return () => clearInterval(t);
  }, [active]);
  return on;
}

// ─── Deal Animation Screen ────────────────────────────────────
const CARD_THEMES = {
  shivaan: "url(/shivaan.png) center/cover no-repeat, #1b6b3a",
  classic: "repeating-linear-gradient(45deg,#1a3a8f 0,#1a3a8f 4px,#c41230 4px,#c41230 8px)",
  gold: "radial-gradient(ellipse at 30% 30%,#f59e0b 0%,#92400e 100%)",
};
const CARD_THEME_LABELS = { shivaan: "Shivaan 🎴", classic: "Classic 🔵🔴", gold: "Gold ✨" };
let CARD_BG = CARD_THEMES.shivaan;
function setCardTheme(t) { CARD_BG = CARD_THEMES[t] || CARD_THEMES.shivaan; }
const CARD_BORDER = "1.5px solid #c8b87a";

function DealScreen({ game, onDone }) {
  const { players, flipped, wildRank } = game;
  const n = players.length;
  const TOTAL = n * 9;

  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState("dealing"); // dealing | pause | flipping | revealed
  const [cardFlipped, setCardFlipped] = useState(false);
  const [showWild, setShowWild] = useState(false);
  const doneRef = useRef(false);
  const finishDeal = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  // Drive the dealing counter forward
  useEffect(() => {
    if (phase !== "dealing") return;
    if (step >= TOTAL) { setPhase("pause"); return; }
    const t = setTimeout(() => { setStep(s => s + 1); Sounds.deal(); }, 65);
    return () => clearTimeout(t);
  }, [step, phase]);

  // After dealing, run flip sequence
  useEffect(() => {
    if (phase !== "pause") return;
    const t1 = setTimeout(() => setPhase("flipping"), 500);
    const t2 = setTimeout(() => { setCardFlipped(true); Sounds.flip(); }, 1000);
    const t3 = setTimeout(() => { setShowWild(true); setPhase("revealed"); }, 1600);
    const t4 = setTimeout(() => finishDeal(), 4300);
    const failsafe = setTimeout(() => finishDeal(), 7000);
    return () => [t1, t2, t3, t4, failsafe].forEach(clearTimeout);
  }, [phase, finishDeal]);

  // Cards dealt to each player at current step
  // Step s deals card to player (s-1)%n  (step 1 = player 0, step 2 = player 1, ...)
  const counts = players.map((_, i) => Math.max(0, Math.ceil((step - i) / n)));
  const activePlayer = phase === "dealing" && step > 0 && step <= TOTAL ? (step - 1) % n : -1;

  // Table layout — player positions around the centre (px offset from 50%,50%)
  const POSITIONS = {
    2: [[0, 115], [0, -115]],
    3: [[0, 115], [-135, -80], [135, -80]],
    4: [[0, 115], [-148, 0], [0, -115], [148, 0]],
  }[n];

  const isFlipPhase = phase === "flipping" || phase === "revealed";

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 999,
      background: "radial-gradient(ellipse at 50% 20%,#1b6b3a 0%,#0a3a1c 100%)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      color: "#fff", fontFamily: "Georgia,serif",
    }}>
      {/* Title */}
      <div style={{ fontSize: 16, letterSpacing: 4, opacity: 0.4, marginBottom: 28, fontWeight: 700, textTransform: "uppercase" }}>
        Shivaan's 9 Card
      </div>

      {/* Status text */}
      <div style={{ fontSize: 13, opacity: 0.55, marginBottom: 20, minHeight: 18, letterSpacing: 1 }}>
        {phase === "dealing" ? `Dealing card ${Math.min(step + 1, TOTAL)} of ${TOTAL}…` :
         phase === "pause"   ? "All cards dealt!" :
         phase === "flipping" && !showWild ? "Revealing Joker rank…" :
         showWild ? `✨  ${wildRank}s are Jokers!` : ""}
      </div>

      {/* Main area */}
      {!isFlipPhase ? (
        /* ── DEALING TABLE ── */
        <div style={{ position: "relative", width: 340, height: 340 }}>

          {/* Centre deck */}
          <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", textAlign: "center" }}>
            <div style={{ fontSize: 8, opacity: 0.35, letterSpacing: 1, marginBottom: 2 }}>DECK</div>
            <div style={{ position: "relative", width: 44, height: 62 }}>
              {Array.from({ length: Math.min(12, Math.max(1, 52 - step)) }, (_, i) => (
                <div key={i} style={{
                  position: "absolute", top: -i * 1.2, left: 0,
                  width: 44, height: 62,
                  background: CARD_BG, borderRadius: 5,
                  border: "1.5px solid #0a3020",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
                }} />
              ))}
            </div>
            <div style={{ fontSize: 10, opacity: 0.4, marginTop: 4 }}>{Math.max(0, 52 - step)}</div>
          </div>

          {/* Player areas */}
          {players.map((p, i) => {
            const [px, py] = POSITIONS[i];
            const isActive = activePlayer === i;
            const count = counts[i];
            return (
              <div key={i} style={{
                position: "absolute",
                left: `calc(50% + ${px}px)`,
                top: `calc(50% + ${py}px)`,
                transform: "translate(-50%,-50%)",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
              }}>
                {/* Name */}
                <div style={{
                  fontSize: 11, fontWeight: isActive ? 700 : 400, whiteSpace: "nowrap",
                  color: isActive ? "#fbbf24" : "rgba(255,255,255,0.55)",
                  transition: "color 0.15s",
                }}>
                  {p.name}{i === 0 ? " 👤" : ""}
                </div>

                {/* Card stack */}
                <div style={{ position: "relative", width: 44, height: 66 }}>
                  {count === 0 ? (
                    <div style={{ width: 42, height: 60, borderRadius: 5, border: "1.5px dashed rgba(255,255,255,0.12)" }} />
                  ) : (
                    Array.from({ length: count }, (_, ci) => (
                      <div key={ci} style={{
                        position: "absolute",
                        width: 40, height: 56,
                        top: -(ci * 1.8),
                        left: ci % 2 === 0 ? 1 : 3,
                        background: CARD_BG, borderRadius: 4,
                        border: isActive && ci === count - 1
                          ? "1.5px solid #fbbf24"
                          : "1px solid #0a3020",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
                        transform: isActive && ci === count - 1 ? "translateY(-4px) scale(1.06)" : "none",
                        transition: "transform 0.12s, border 0.12s",
                      }} />
                    ))
                  )}
                </div>

                {/* Count badge */}
                <div style={{
                  fontSize: 13, fontWeight: 700, minWidth: 32, textAlign: "center",
                  color: isActive ? "#fbbf24" : "rgba(255,255,255,0.65)",
                  transition: "color 0.15s",
                }}>
                  {count}<span style={{ opacity: 0.35, fontSize: 9 }}>/9</span>
                </div>
              </div>
            );
          })}
        </div>

      ) : (
        /* ── FLIP REVEAL ── */
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>

          {/* Flip reveal — the card back shows first, then the face is revealed.
              Uses an opacity crossfade + a self-correcting scaleX flip (never a
              3D/backface flip, which repeatedly got stuck blank in the Android WebView). */}
          <div style={{
            position: "relative",
            width: 120, height: 168, borderRadius: 9,
            boxShadow: "0 8px 28px rgba(0,0,0,0.6)",
            transform: showWild ? "scale(1.04)" : "scale(1)",
            transition: "transform 0.25s ease",
          }}>
            {/* Card back (shown before the flip) */}
            <div style={{
              position: "absolute", inset: 0, borderRadius: 9,
              background: CARD_BG, border: CARD_BORDER,
              opacity: cardFlipped ? 0 : 1, transition: "opacity 0.3s ease",
            }} />

            {/* Card face (revealed after the flip) */}
            <div style={{
              position: "absolute", inset: 0, borderRadius: 9,
              background: "#fffef2", border: "2.5px solid #c8b87a",
              display: "flex", flexDirection: "column", overflow: "hidden",
              opacity: cardFlipped ? 1 : 0, transition: "opacity 0.3s ease",
            }}>
                {flipped?.rank === "JOKER" ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#7c3aed" }}>
                    <span style={{ fontSize: 34 }}>🃏</span>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1 }}>JOKER</span>
                  </div>
                ) : (
                  <React.Fragment>
                    <div style={{ padding: "4px 6px", fontSize: 14, fontWeight: 800, color: isRed(flipped?.suit) ? "#dc2626" : "#1e293b", lineHeight: 1.2 }}>
                      {flipped?.rank}<br />{flipped?.suit}
                    </div>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, color: isRed(flipped?.suit) ? "#dc2626" : "#1e293b" }}>
                      {flipped?.suit}
                    </div>
                    <div style={{ padding: "4px 6px", fontSize: 14, fontWeight: 800, color: isRed(flipped?.suit) ? "#dc2626" : "#1e293b", lineHeight: 1.2, transform: "rotate(180deg)", alignSelf: "flex-end" }}>
                      {flipped?.rank}<br />{flipped?.suit}
                    </div>
                    {flipped?.isWild && <div style={{ position: "absolute", top: 0, right: 0, background: "#f59e0b", color: "#fff", fontSize: 8, fontWeight: 800, padding: "2px 4px", borderRadius: "0 8px 0 4px" }}>W</div>}
                  </React.Fragment>
                )}
            </div>
          </div>

          {/* Wild rank announcement */}
          <div style={{
            textAlign: "center",
            opacity: showWild ? 1 : 0,
            transform: showWild ? "translateY(0) scale(1)" : "translateY(10px) scale(0.95)",
            transition: "all 0.5s ease",
          }}>
            <div style={{ fontSize: 30, fontWeight: 900, color: "#fbbf24", letterSpacing: 3, textShadow: "0 0 24px rgba(251,191,36,0.5)" }}>
              ✨ {wildRank}s ARE WILD
            </div>
            <div style={{ fontSize: 12, opacity: 0.45, marginTop: 8 }}>
              All {wildRank}s + both Jokers = 6 Joker cards in play
            </div>
          </div>
        </div>
      )}

      {/* Continue button — "Skip" before the reveal, "Next" once the card is showing */}
      <button onClick={finishDeal} style={{
        marginTop: 32,
        padding: cardFlipped ? "11px 34px" : "6px 18px",
        borderRadius: cardFlipped ? 12 : 8,
        fontSize: cardFlipped ? 16 : 12,
        fontWeight: cardFlipped ? 800 : 400,
        background: cardFlipped ? "#16a34a" : "rgba(255,255,255,0.08)",
        color: cardFlipped ? "#fff" : "rgba(255,255,255,0.4)",
        border: cardFlipped ? "none" : "1px solid rgba(255,255,255,0.12)",
        boxShadow: cardFlipped ? "0 4px 16px rgba(22,163,74,0.45)" : "none",
        cursor: "pointer", transition: "all 0.25s ease",
      }}>
        {cardFlipped ? "Next ▶" : "Skip ▶"}
      </button>
    </div>
  );
}

// ─── Setup Screen ────────────────────────────────────────────
function SetupScreen({ onStart, onBack }) {
  const [step, setStep] = useState(1);
  const [numP, setNumP] = useState(2);
  // Pre-fill CPU slots with funny random names; human slot stays blank
  const [names, setNames] = useState(() => {
    const funny = pickFunnyCpuNames(3);
    return ["", funny[0], funny[1], funny[2]];
  });

  // Re-randomise CPU names whenever player count changes
  function pickCount(x) {
    const funny = pickFunnyCpuNames(3);
    setNames(prev => ["", funny[0], funny[1], funny[2]]);
    setNumP(x);
    setStep(2);
  }

  function go() {
    const pNames = Array.from({ length: numP }, (_, i) => {
      const n = names[i] ? names[i].trim() : "";
      // CPU slots fall back to the pre-generated funny name
      return n || (i === 0 ? "You" : names[i] || "CPU " + i);
    });
    onStart(numP, pNames);
  }

  const inputStyle = {
    width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 15, fontWeight: 600,
    background: "rgba(255,255,255,0.1)", border: "1.5px solid rgba(255,255,255,0.25)",
    color: "#fff", outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(ellipse at 50% 30%,#1b6b3a 0%,#072515 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Georgia,serif", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 480, marginBottom: 28 }}>
        <GameLogo />
      </div>

      {step === 1 ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <p style={{ margin: "0 0 18px", fontSize: 16, fontWeight: 600, opacity: 0.9 }}>How many players?</p>
          <div style={{ display: "flex", gap: 16, marginBottom: 40 }}>
            {[2, 3, 4].map(x => (
              <button key={x} onClick={() => pickCount(x)}
                style={{ width: 78, height: 78, borderRadius: 14, fontSize: 30, fontWeight: 800, background: "rgba(255,255,255,0.1)", border: "2px solid rgba(255,255,255,0.3)", color: "#fff", cursor: "pointer", transition: "all .2s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.25)"; e.currentTarget.style.transform = "scale(1.1)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; e.currentTarget.style.transform = "scale(1)"; }}>
                {x}
              </button>
            ))}
          </div>
          <div style={{ background: "rgba(0,0,0,0.35)", borderRadius: 14, padding: "18px 24px", maxWidth: 420, fontSize: 13, lineHeight: 2, border: "1px solid rgba(255,255,255,0.1)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, opacity: 0.45, marginBottom: 8 }}>HOW TO PLAY</div>
            🃏 9 cards each · flipped card reveals Joker rank (+2 Jokers = 6 total)<br />
            🎯 <strong>Come down</strong> first with 4+ consecutive same-suit cards<br />
            ➕ Then add to any table set or play 3+ card runs<br />
            🔄 <strong>Drag</strong> to reorder hand · <strong>Swap</strong> a wild with its real card<br />
            👑 Ace = 1 or after King · 🏆 Lowest cumulative score wins!
          </div>
          {onBack && (
            <button onClick={onBack} style={{ marginTop: 20, padding: "10px 28px", borderRadius: 10, fontSize: 14, fontWeight: 700, background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }}>
              ← Back to Menu
            </button>
          )}
        </div>
      ) : (
        <div style={{ width: "100%", maxWidth: 360 }}>
          <p style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 600, opacity: 0.85, textAlign: "center" }}>Enter player names</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 }}>
            {Array.from({ length: numP }, (_, i) => (
              <div key={i}>
                <div style={{ fontSize: 11, opacity: 0.45, marginBottom: 5, letterSpacing: 1 }}>
                  {i === 0 ? "PLAYER 1 (YOU)" : "PLAYER " + (i + 1) + " · CPU " + i}
                </div>
                <input type="text" maxLength={16}
                  placeholder={i === 0 ? "Your name" : names[i] || "CPU " + i}
                  value={names[i]}
                  onChange={e => { const a = [...names]; a[i] = e.target.value; setNames(a); }}
                  style={inputStyle} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => setStep(1)} style={{ flex: 1, padding: "12px", borderRadius: 10, fontSize: 14, fontWeight: 700, background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }}>← Back</button>
            <button onClick={go} style={{ flex: 2, padding: "12px", borderRadius: 10, fontSize: 16, fontWeight: 800, background: "#16a34a", color: "#fff", border: "none", cursor: "pointer" }}>Start Game ▶</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Round Over Screen ───────────────────────────────────────
function RoundOverScreen({ series, onNext, onEnd, onRematch }) {
  const winner = series.players.find(p => p.id === series.lastWin);
  const sorted = [...series.players].sort((a, b) => a.total - b.total);
  const medals = ["🥇", "🥈", "🥉", "4️⃣"];
  const stars = n => "⭐".repeat(Math.min(n, 8));

  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(ellipse at 50% 20%,#1b6b3a 0%,#072515 100%)", display: "flex", flexDirection: "column", alignItems: "center", color: "#fff", fontFamily: "Georgia,serif", padding: "24px 16px", overflowY: "auto" }}>
      <div style={{ fontSize: 48, marginBottom: 6 }}>🏆</div>
      <h2 style={{ fontSize: 26, margin: "0 0 4px", fontWeight: 900 }}>Round {series.round} Complete!</h2>
      <p style={{ opacity: 0.6, marginBottom: 24, fontSize: 14 }}>{winner ? winner.name : "?"} won this round!</p>

      <div style={{ width: "100%", maxWidth: 440, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.4, marginBottom: 8 }}>ROUND SCORES</div>
        {series.players.map(p => {
          const isW = p.id === series.lastWin;
          return (
            <div key={p.id} style={{ background: isW ? "rgba(251,191,36,0.12)" : "rgba(0,0,0,0.28)", borderRadius: 10, padding: "10px 14px", marginBottom: 8, border: isW ? "1px solid rgba(251,191,36,0.3)" : "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: p.lastItems && p.lastItems.length ? 4 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</span>
                  {isW && <span style={{ fontSize: 11, color: "#fbbf24" }}>⭐ ROUND WIN</span>}
                  {isW && p.lastWildWin && <span style={{ fontSize: 11, color: "#f87171", fontWeight: 700 }}>🃏 Joker/Wild finish +30</span>}
                  {p.lastBonus < 0 && <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 700 }}>🎉 3-in-a-row! −50</span>}
                </div>
                <span style={{ fontWeight: 800, fontSize: 16, color: isW && (p.lastPts || 0) === 0 ? "#4ade80" : (p.lastPts || 0) > 0 ? "#f87171" : "#fff" }}>
                  {(p.lastPts || 0) > 0 ? "+" + p.lastPts + " pts" : "0 pts"}
                </span>
              </div>
              {p.lastItems && p.lastItems.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {p.lastNoSet && <div style={{ fontSize: 10, color: "#fca5a5", marginBottom: 4 }}>⚠️ No set played — +30 penalty</div>}
                  {/* Show actual remaining cards */}
                  {p.lastHand && p.lastHand.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                      {p.lastHand.map((c, ci) => (
                        <div key={ci} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                          <CardView card={c} small />
                          <span style={{ fontSize: 8, color: "#fbbf24", fontWeight: 700 }}>+{cardPoints(c)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Fallback text breakdown if no cards */}
                  {(!p.lastHand || !p.lastHand.length) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {p.lastItems.filter(i => i.label !== "No set played").map((item, j) => (
                        <span key={j} style={{ fontSize: 10, background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: 4, opacity: 0.8 }}>{item.label} +{item.pts}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ width: "100%", maxWidth: 440, marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.4, marginBottom: 8 }}>RUNNING TOTALS — lowest wins</div>
        {sorted.map((p, rank) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(0,0,0,0.25)", borderRadius: 8, padding: "8px 12px", marginBottom: 6 }}>
            <span style={{ fontSize: 18, width: 24 }}>{medals[rank] || "·"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 1 }}>{stars(p.wins)} {p.wins} win{p.wins !== 1 ? "s" : ""}</div>
            </div>
            <span style={{ fontWeight: 800, fontSize: 18, color: rank === 0 ? "#fbbf24" : "#fff" }}>{p.total}</span>
          </div>
        ))}
      </div>

      {/* Round Stats */}
      {series.roundStats && (
        <div style={{ width: "100%", maxWidth: 440, marginBottom: 20 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.4, marginBottom: 8 }}>ROUND HIGHLIGHTS</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {series.roundStats.winnerName && <div style={{ flex: 1, minWidth: 100, background: "rgba(0,0,0,0.25)", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>🏆</div>
              <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>ROUND WINNER</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{series.roundStats.winnerName}</div>
            </div>}
            {series.roundStats.closest && <div style={{ flex: 1, minWidth: 100, background: "rgba(0,0,0,0.25)", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>🎯</div>
              <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>CLOSEST</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{series.roundStats.closest}</div>
            </div>}
            {series.roundStats.heaviest && <div style={{ flex: 1, minWidth: 100, background: "rgba(0,0,0,0.25)", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>😬</div>
              <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>MOST POINTS</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{series.roundStats.heaviest}</div>
            </div>}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <button onClick={onNext} style={{ padding: "13px 36px", borderRadius: 12, fontSize: 16, fontWeight: 800, background: "#16a34a", color: "#fff", border: "none", cursor: "pointer" }}>▶ Next Round</button>
        {onRematch && <button onClick={onRematch} style={{ padding: "13px 36px", borderRadius: 12, fontSize: 15, fontWeight: 700, background: "#7c3aed", color: "#fff", border: "none", cursor: "pointer" }}>🔄 Rematch</button>}
        <button onClick={onEnd} style={{ padding: "13px 36px", borderRadius: 12, fontSize: 16, fontWeight: 700, background: "rgba(255,255,255,0.1)", color: "#fff", border: "2px solid rgba(255,255,255,0.2)", cursor: "pointer" }}>🏁 End Game</button>
      </div>
    </div>
  );
}

// ─── Game Over Screen ────────────────────────────────────────
function GameOverScreen({ series, onNew, onRematch, onRecentGames }) {
  const sorted = [...series.players].sort((a, b) => a.total - b.total);
  const medals = ["🥇", "🥈", "🥉", "4️⃣"];
  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(ellipse at 50% 20%,#1b6b3a 0%,#072515 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Georgia,serif", padding: "24px 16px" }}>
      <div style={{ fontSize: 64, marginBottom: 10 }}>🏆</div>
      <h1 style={{ fontSize: 38, margin: "0 0 4px", fontWeight: 900 }}>Game Over!</h1>
      <p style={{ opacity: 0.4, marginBottom: 4, fontSize: 12, letterSpacing: 2 }}>SHIV'S 9 CARD</p>
      <p style={{ opacity: 0.55, marginBottom: 32, fontSize: 14 }}>{series.round} round{series.round !== 1 ? "s" : ""} played · Lowest score wins</p>
      <div style={{ width: "100%", maxWidth: 420, marginBottom: 36 }}>
        {sorted.map((p, rank) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, background: rank === 0 ? "rgba(251,191,36,0.15)" : "rgba(0,0,0,0.3)", borderRadius: 12, padding: "14px 16px", marginBottom: 10, border: rank === 0 ? "2px solid rgba(251,191,36,0.4)" : "1px solid rgba(255,255,255,0.06)" }}>
            <span style={{ fontSize: 28 }}>{medals[rank] || "·"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>
                {p.name}{rank === 0 && <span style={{ fontSize: 12, color: "#fbbf24", marginLeft: 8 }}>WINNER</span>}
              </div>
              <div style={{ fontSize: 12, opacity: 0.5, marginTop: 3 }}>{"⭐".repeat(Math.min(p.wins, 8))}{p.wins > 0 ? " " + p.wins + " win" + (p.wins !== 1 ? "s" : "") : ""}</div>
            </div>
            <span style={{ fontWeight: 900, fontSize: 24, color: rank === 0 ? "#fbbf24" : "#fff" }}>{p.total}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        {onRematch && <button onClick={onRematch} style={{ padding: "14px 52px", borderRadius: 12, fontSize: 18, fontWeight: 800, background: "#7c3aed", color: "#fff", border: "none", cursor: "pointer" }}>🔄 Rematch — Same Players</button>}
        <button onClick={onNew} style={{ padding: "14px 52px", borderRadius: 12, fontSize: 18, fontWeight: 800, background: "#fbbf24", color: "#1c1c1c", border: "none", cursor: "pointer" }}>New Game</button>
        {onRecentGames && <button onClick={onRecentGames} style={{ padding: "10px 32px", borderRadius: 12, fontSize: 14, fontWeight: 700, background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }}>🏆 Recent Games</button>}
      </div>
    </div>
  );
}

// ─── Game Screen ─────────────────────────────────────────────
function GameScreen({ game, setGame, series, onEnd, onAction }) {
  const { players, currentPlayer, phase, selectedIds, addMode, placementIdx, tableSets, deck, discardPile, flipped, wildRank, message } = game;
  const human = players[0];
  const isMyTurn = currentPlayer === 0;
  const topDiscard = discardPile[discardPile.length - 1];
  const selCards = selectedIds.map(id => human.hand.find(c => c.id === id)).filter(Boolean);

  // Offline recall timer: if a Joker/Wild is thrown, give the player 5 seconds to recall before the next player can take it.
  useEffect(() => {
    if (onAction || phase !== "recall" || game.recallBy !== 0) return;
    const t = setTimeout(() => {
      setGame(g => {
        if (!g || g.phase !== "recall" || g.recallBy !== 0) return g;
        const next = (g.currentPlayer + 1) % g.players.length;
        return { ...g, currentPlayer: next, phase: "draw", recallBy: null, recallCard: null, selectedIds: [], message: next === 0 ? "🎮 Your turn! Pick Up a card." : g.players[next].name + "'s turn..." };
      });
    }, 5000);
    return () => clearTimeout(t);
  }, [onAction, phase, game.recallBy, setGame]);

  // Keep screen awake while game is active
  useEffect(() => {
    let wakeLock = null;
    async function requestWakeLock() {
      try {
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch (e) {}
    }
    requestWakeLock();
    // Re-acquire on visibility change (lock is released when tab goes to background)
    function onVisChange() { if (document.visibilityState === "visible") requestWakeLock(); }
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      wakeLock?.release().catch(() => {});
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, []);

  const dragRef = useRef({ id: null, idx: null });
  const [dragOver, setDragOver] = useState(null);
  const touchRef = useRef({ active: false });

  function reorder(from, to) {
    if (from === to || from == null || to == null) return;
    setGame(g => {
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      const h = ps[0].hand;
      const [card] = h.splice(from, 1);
      h.splice(to > from ? to - 1 : to, 0, card);
      return { ...g, players: ps };
    });
  }

  function onDragStart(e, id, idx) { dragRef.current = { id, idx }; e.dataTransfer.effectAllowed = "move"; }
  function onDragOver(e, idx) { e.preventDefault(); setDragOver(idx); }
  function onDrop(e, idx) { e.preventDefault(); reorder(dragRef.current.idx, idx); setDragOver(null); }
  function onDragEnd() { setDragOver(null); dragRef.current = { id: null, idx: null }; }

  function onTouchStart(e, id, idx) { touchRef.current = { active: true, from: idx, sx: e.touches[0].clientX, sy: e.touches[0].clientY, moved: false }; }
  function onTouchMove(e) {
    if (!touchRef.current.active) return;
    const dx = e.touches[0].clientX - touchRef.current.sx, dy = e.touches[0].clientY - touchRef.current.sy;
    // Allow normal vertical scrolling when the user is moving mostly up/down.
    // Only treat it as card reordering when the movement is clearly horizontal.
    const horizontalDrag = Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) + 8;
    if (!horizontalDrag) return;
    touchRef.current.moved = true;
    e.preventDefault();
    const el = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
    const ci = el && el.closest("[data-ci]");
    setDragOver(ci ? parseInt(ci.dataset.ci) : null);
  }
  function onTouchEnd(e) {
    if (!touchRef.current.active) return;
    if (touchRef.current.moved) {
      const el = document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      const ci = el && el.closest("[data-ci]");
      if (ci) reorder(touchRef.current.from, parseInt(ci.dataset.ci));
    }
    touchRef.current = { active: false };
    setDragOver(null);
  }

  function tapCard(id) {
    if (!isMyTurn || phase === "draw") return;
    setGame(g => ({ ...g, selectedIds: g.selectedIds.includes(id) ? g.selectedIds.filter(x => x !== id) : [...g.selectedIds, id], placementIdx: null }));
  }

  function drawFromDeck() {
    if (!isMyTurn || phase !== "draw") return;
    Sounds.draw();
    if (onAction) onAction("draw_deck", {});
    setGame(g => {
      let nd = g.deck, dp = g.discardPile, ts = g.tableSets;
      // If deck empty, reshuffle discard; if both empty, reshuffle table sets
      if (!nd.length && dp.length > 1) {
        const top = dp.pop(); nd = shuffle([...dp]); dp = [top];
      } else if (!nd.length && !dp.length) {
        const reshuffled = reshuffleTableSets(nd, dp, ts, g.wildRank);
        nd = reshuffled.deck; dp = reshuffled.discardPile; ts = reshuffled.tableSets;
      }
      if (!nd.length) return { ...g, message: "⚠️ No cards available to draw!" };
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      ps[0].hand.push(nd[nd.length - 1]);
      return { ...g, players: ps, deck: nd.slice(0, -1), discardPile: dp, tableSets: ts, phase: "play", selectedIds: [], message: "Play a set, add to a set, or discard to end turn." };
    });
  }

  function drawFromDiscard() {
    if (!isMyTurn || phase !== "draw" || !topDiscard) return;
    Sounds.draw();
    if (onAction) onAction("draw_discard", {});
    setGame(g => {
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      ps[0].hand.push(g.discardPile[g.discardPile.length - 1]);
      return { ...g, players: ps, discardPile: g.discardPile.slice(0, -1), phase: "play", selectedIds: [], message: "Picked up discard. Play or discard." };
    });
  }

  function playSet() {
    if (!isMyTurn || phase !== "play") return;
    if (selCards.length < 3) return setGame(g => ({ ...g, message: "❌ Select at least 3 cards." }));

    if (!human.hasComDown) {
      // Try double come-down: 4+ and 3+ melds in one play
      if (selCards.length >= 7) {
        const twoMelds = findTwoMelds(selCards);
        if (twoMelds) {
          // Check suit duplicates for both sets
          const existing = suitsOnTable(tableSets);
          for (const m of twoMelds) {
            if (isDonutSet(m)) { if (!canPlayDonkeySet(tableSets, m)) return setGame(g => ({ ...g, message: "❌ Donkey set needs all 4 suits represented. Jokers can fill missing suits." })); }
            else { const ns = getRunSuit(m); if (ns && existing.has(ns)) return setGame(g => ({ ...g, message: `❌ A ${ns} set is already on the table!` })); }
          }
          if (onAction) onAction("play_two_sets", { set1Ids: twoMelds[0].map(c => c.id), set2Ids: twoMelds[1].map(c => c.id) });
          setGame(g => {
            const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
            let ts = [...g.tableSets];
            let allIds = new Set(selCards.map(c => c.id));
            const hasWild = selCards.some(c => c.isWild);
            for (const m of twoMelds) {
              const mIds = new Set(m.map(c => c.id));
              ps[0].hand = ps[0].hand.filter(c => !mIds.has(c.id));
              ts.push({ playerId: 0, playerName: human.name, cards: m });
            }
            ps[0].hasComDown = true;
            if (!ps[0].hand.length) return { ...g, players: ps, tableSets: ts, winner: 0, wildWin: hasWild };
            return { ...g, players: ps, tableSets: ts, selectedIds: [], addMode: false, placementIdx: null, message: "✅ Double come-down! Both sets played." };
          });
          return;
        }
      }
      // Single come-down: must be 4+
      if (!validMeld(selCards)) return setGame(g => ({ ...g, message: "❌ Not valid — needs consecutive same-suit cards." }));
      if (selCards.length < 4) return setGame(g => ({ ...g, message: "❌ First set must be 4+ cards. Select 7+ cards to play two sets at once!" }));
    } else {
      if (!validMeld(selCards)) return setGame(g => ({ ...g, message: "❌ Not valid — needs consecutive same-suit cards." }));
    }

    // Suit duplicate check
    const existingSuits = suitsOnTable(tableSets);
    if (isDonutSet(selCards)) {
      if (!canPlayDonkeySet(tableSets, selCards)) return setGame(g => ({ ...g, message: "❌ Donkey set needs all 4 suits represented. Jokers can fill missing suits." }));
    } else {
      const newSuit = getRunSuit(selCards);
      if (newSuit && existingSuits.has(newSuit)) return setGame(g => ({ ...g, message: `❌ A ${newSuit} set is already on the table!` }));
    }
    if (onAction) onAction("play_set", { cardIds: selCards.map(c => c.id) });
    setGame(g => {
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      const ids = new Set(g.selectedIds);
      const played = g.selectedIds.map(id => ps[0].hand.find(c => c.id === id)).filter(Boolean);
      const hasWild = played.some(c => c.isWild);
      ps[0].hand = ps[0].hand.filter(c => !ids.has(c.id));
      if (!ps[0].hasComDown) ps[0].hasComDown = true;
      const ts = [...g.tableSets, { playerId: 0, playerName: human.name, cards: played }];
      if (!ps[0].hand.length) return { ...g, players: ps, tableSets: ts, winner: 0, wildWin: hasWild };
      return { ...g, players: ps, tableSets: ts, selectedIds: [], addMode: false, placementIdx: null, message: "✅ Set played!" };
    });
  }

  function toggleAdd() {
    if (!isMyTurn || phase !== "play") return;
    if (addMode) return setGame(g => ({ ...g, addMode: false, placementIdx: null, message: "Add mode cancelled." }));
    if (!human.hasComDown) return setGame(g => ({ ...g, message: "❌ Come down first (play a 4+ card set)." }));
    if (!selCards.length) return setGame(g => ({ ...g, message: "❌ Select a card first, then click Add to Set." }));
    setGame(g => ({ ...g, addMode: true, placementIdx: null, message: "👉 Click a table set to place your card." }));
  }

  function openPlacement(idx) {
    if (!isMyTurn || !addMode || selCards.length !== 1) return;
    setGame(g => ({ ...g, placementIdx: idx, message: "Choose where to place the card." }));
  }

  function doPlace(type, wildId) {
    const sc = human.hand.find(c => selectedIds.includes(c.id));
    const idx = placementIdx;
    if (!sc || idx == null) return;
    Sounds.play();
    if (onAction) onAction("add_to_set", { cardId: sc.id, setIdx: idx, type, wildId: wildId || null });
    setGame(g => {
      const sc = g.players[0].hand.find(c => g.selectedIds.includes(c.id));
      const idx = g.placementIdx;
      const tc = g.tableSets[idx].cards;
      let nc, wildBack = null;
      if (type === "wild") {
        wildBack = tc.find(c => c.id === wildId);
        nc = tc.map(c => c.id === wildId ? sc : c);
      } else if (type === "start") {
        nc = [sc, ...tc];
      } else {
        nc = [...tc, sc];
      }
      if (!validMeld(nc)) return { ...g, placementIdx: null, addMode: false, message: "❌ Invalid placement." };
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      ps[0].hand = ps[0].hand.filter(c => c.id !== sc.id);
      if (wildBack) ps[0].hand.push({ ...wildBack, isWild: true });
      const ts = g.tableSets.map((s, i) => i === idx ? { ...s, cards: nc } : s);
      if (!ps[0].hand.length) return { ...g, players: ps, tableSets: ts, winner: 0, wildWin: sc.isWild || (wildBack !== null) };
      return { ...g, players: ps, tableSets: ts, selectedIds: [], addMode: false, placementIdx: null, message: "✅ Card placed!" + (wildBack ? " (wild returned to hand)" : "") };
    });
  }

  function doDiscard() {
    if (!isMyTurn || phase !== "play") return;
    if (selectedIds.length !== 1) return setGame(g => ({ ...g, message: "❌ Select exactly 1 card to discard.", wildConfirmed: false }));
    Sounds.discard();
    if (onAction) onAction("discard", { cardId: selectedIds[0] });
    setGame(g => {
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      const id = g.selectedIds[0];
      const card = ps[0].hand.find(c => c.id === id);
      ps[0].hand = ps[0].hand.filter(c => c.id !== id);
      const dp = [...g.discardPile, card];
      // Wild win rule: discarding a wild as last card = win +30 points and still counts as a round win.
      if (!ps[0].hand.length) return { ...g, players: ps, discardPile: dp, winner: 0, wildWin: card.isWild, wildConfirmed: false };
      if (card.isWild) {
        return { ...g, players: ps, discardPile: dp, phase: "recall", recallBy: 0, recallCard: card.id, selectedIds: [], addMode: false, placementIdx: null, wildConfirmed: false, message: "🃏 Joker/Wild thrown — 5 seconds to recall it!" };
      }
      let nd = g.deck, fd = dp, ts = g.tableSets;
      if (!nd.length && dp.length > 1) {
        const top = dp.pop(); nd = shuffle([...dp]); fd = [top];
      } else if (!nd.length && !dp.length) {
        // Both empty — reshuffle table sets back into deck
        const reshuffled = reshuffleTableSets(nd, dp, ts, g.wildRank);
        nd = reshuffled.deck; fd = reshuffled.discardPile; ts = reshuffled.tableSets;
      }
      const next = (g.currentPlayer + 1) % g.players.length;
      return { ...g, players: ps, deck: nd, discardPile: fd, tableSets: ts, currentPlayer: next, phase: "draw", selectedIds: [], addMode: false, placementIdx: null, wildConfirmed: false, message: next === 0 ? "🎮 Your turn! Pick Up a card." : g.players[next].name + "'s turn..." };
    });
  }

  function recallWild() {
    if (phase !== "recall" || game.recallBy !== 0 || !topDiscard?.isWild) return;
    Sounds.draw();
    if (onAction) onAction("recall_wild", {});
    setGame(g => {
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      const card = g.discardPile[g.discardPile.length - 1];
      if (!card) return g;
      ps[0].hand.push(card);
      return { ...g, players: ps, discardPile: g.discardPile.slice(0, -1), phase: "play", recallBy: null, recallCard: null, selectedIds: [], message: "✅ Joker/Wild recalled. Play or throw again." };
    });
  }

  function sortHand() {
    setGame(g => {
      const ps = g.players.map(p => ({ ...p, hand: [...p.hand] }));
      ps[0].hand.sort((a, b) => {
        if (a.isWild && !b.isWild) return 1;
        if (!a.isWild && b.isWild) return -1;
        if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
        return rv(a.rank) - rv(b.rank);
      });
      return { ...g, players: ps };
    });
  }

  const cpuPlayers = players.filter(p => p.isAI);
  const pulse = usePulse(isMyTurn && phase === "draw");

  // Sound effects on game events
  useEffect(() => {
    if (game.winner !== null && game.winner !== undefined) Sounds.win();
  }, [game.winner]);

  return (
    <div style={{ minHeight: "100dvh", height: "auto", background: "radial-gradient(ellipse at 50% 0%,#1f1b13 0%,#111219 32%,#07080d 100%)", display: "flex", flexDirection: "column", fontFamily: "Georgia,serif", color: "#fff", padding: "calc(72px + env(safe-area-inset-top)) 10px calc(34px + env(safe-area-inset-bottom))", boxSizing: "border-box", maxWidth: 860, margin: "0 auto", overflowY: "visible", overflowX: "hidden", WebkitOverflowScrolling: "touch", touchAction: "pan-y pinch-zoom" }}>

      {/* Game title + scoreboard */}
      <div style={{ padding: "2px 2px 8px", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 22, letterSpacing: 1.4, color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,0.55)", flex: 1 }}>🃏 Shivaan's 9 Card</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
          {series && series.players.map(p => (
            <div key={p.id} style={{ flex: "1 1 96px", minWidth: 96, background: "linear-gradient(180deg,rgba(255,255,255,0.08),rgba(0,0,0,0.28))", borderRadius: 12, padding: "7px 9px", border: p.id === currentPlayer ? "1.5px solid rgba(212,175,55,0.75)" : "1px solid rgba(212,175,55,0.18)", boxShadow: p.id === currentPlayer ? "0 0 14px rgba(212,175,55,0.18)" : "none" }}>
              <div style={{ fontSize: 11, opacity: 0.72, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}{p.id === currentPlayer ? " • TURN" : ""}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontSize: 21, fontWeight: 900, color: "#f8d36f" }}>{p.total}</span>
                <span style={{ fontSize: 10, opacity: 0.55 }}>pts</span>
                {p.wins > 0 && <span style={{ color: "#fbbf24", marginLeft: 3, fontSize: 10 }}>{"⭐".repeat(Math.min(p.wins, 3))}</span>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 12, opacity: 0.72 }}>
          {series && <span style={{ background: "rgba(0,0,0,0.32)", borderRadius: 999, padding: "4px 9px" }}>Round {series.round + 1}</span>}
          <span>Joker: <span style={{ color: "#f8d36f", fontWeight: 900 }}>{wildRank}s</span></span>
        </div>
      </div>

      {/* CPU players with pulse indicator */}
      {cpuPlayers.length > 0 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 6, flexWrap: "wrap" }}>
          {cpuPlayers.map(p => {
            const isActive = currentPlayer === p.id;
            return (
              <div key={p.id} className={isActive ? "active-player-glow" : ""}
                style={{ background: "rgba(0,0,0,0.32)", borderRadius: 10, padding: "6px 10px", border: isActive ? "2px solid #fbbf24" : "2px solid rgba(255,255,255,0.07)", minWidth: 90, boxShadow: isActive ? "0 0 12px rgba(251,191,36,0.5)" : "none", transition: "box-shadow 0.4s, border-color 0.4s" }}>
                <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 5, display: "flex", gap: 4, alignItems: "center" }}>
                  {p.name}
                  {isActive && <span style={{ fontSize: 9, color: "#fbbf24" }}>● TURN</span>}
                  {p.hasComDown && <span style={{ color: "#4ade80", fontSize: 10 }}>✓DOWN</span>}
                  <span style={{ marginLeft: "auto", opacity: 0.6 }}>{p.hand.length}c</span>
                </div>
                <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                  {p.hand.map((_, i) => (
                    <div key={i} style={{ width: 16, height: 22, background: CARD_BG, borderRadius: 2, border: "1px solid #c8b87a" }} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Table */}
      <div style={{ background: "linear-gradient(180deg,rgba(255,255,255,0.035),rgba(0,0,0,0.34))", borderRadius: 14, padding: "12px 14px", marginBottom: 10, minHeight: 92, maxHeight: "34dvh", overflowY: "auto", overflowX: "hidden", WebkitOverflowScrolling: "touch", touchAction: "pan-y pinch-zoom", border: "1px solid rgba(212,175,55,0.34)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.025),0 8px 24px rgba(0,0,0,0.22)" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, opacity: 0.35, marginBottom: 6 }}>TABLE</div>
        {tableSets.length === 0 ? (
          <div style={{ opacity: 0.22, fontSize: 12, fontStyle: "italic" }}>No sets on the table yet...</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {tableSets.map((meld, idx) => {
              const isPT = placementIdx === idx;
              const isClickable = addMode && isMyTurn && !isPT && selCards.length === 1;
              return (
                <div key={idx}>
                  <div onClick={isClickable ? () => openPlacement(idx) : undefined}
                    style={{ background: isPT ? "rgba(251,191,36,0.08)" : isClickable ? "rgba(251,191,36,0.06)" : "rgba(0,0,0,0.22)", borderRadius: 8, padding: "6px 8px", border: isPT ? "2px solid #fbbf24" : isClickable ? "2px dashed rgba(251,191,36,0.5)" : "1px solid rgba(255,255,255,0.08)", cursor: isClickable ? "pointer" : "default" }}>
                    <div style={{ fontSize: 9, opacity: 0.4, marginBottom: 4 }}>{meld.playerName}</div>
                    <div style={{ display: "flex", gap: 2 }}>
                      {sortMeld(meld.cards).map(slot => (
                        <div key={slot.card.id} style={{ position: "relative" }}>
                          <CardView card={slot.card} small />
                          {slot.isWild && slot.rk !== "?" && (
                            <div style={{
                              position: "absolute", bottom: 2, right: 2,
                              background: "#1e293b", color: "#fbbf24",
                              fontSize: 7, fontWeight: 800, lineHeight: 1.2,
                              padding: "1px 3px", borderRadius: 3,
                              border: "1px solid rgba(251,191,36,0.5)",
                              textAlign: "center", pointerEvents: "none",
                            }}>
                              {slot.rk}<br />{slot.suit === "?" ? "" : slot.suit}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  {isPT && selCards.length === 1 && (
                    <PlacementPanel meld={meld} selCard={selCards[0]} onPlace={doPlace}
                      onCancel={() => setGame(g => ({ ...g, placementIdx: null, message: "Placement cancelled." }))} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Deck / Discard / Flipped */}
      <div style={{ display: "flex", gap: 18, justifyContent: "center", alignItems: "flex-end", marginBottom: 4 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, opacity: 0.4, marginBottom: 3 }}>DECK ({deck.length})</div>
          <div onClick={drawFromDeck} style={{ opacity: isMyTurn && phase === "draw" && deck.length ? 1 : 0.5, cursor: isMyTurn && phase === "draw" && deck.length ? "pointer" : "default" }}>
            {deck.length ? <CardView card={{ rank: "?", suit: "?", isWild: false }} faceDown /> : (
              <div style={{ width: 54, height: 76, borderRadius: 5, border: "2px dashed rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, opacity: 0.3 }}>Empty</div>
            )}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, opacity: 0.4, marginBottom: 3 }}>THROW</div>
          <div onClick={drawFromDiscard} style={{ opacity: isMyTurn && phase === "draw" && topDiscard ? 1 : 0.5, cursor: isMyTurn && phase === "draw" && topDiscard ? "pointer" : "default" }}>
            {topDiscard ? <CardView card={topDiscard} /> : (
              <div style={{ width: 54, height: 76, borderRadius: 5, border: "2px dashed rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, opacity: 0.3 }}>Empty</div>
            )}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, opacity: 0.4, marginBottom: 3 }}>FLIPPED</div>
          {flipped && <CardView card={flipped} />}
          <div style={{ fontSize: 9, color: "#fbbf24", marginTop: 4, fontWeight: 700 }}>→ Joker: {wildRank}</div>
        </div>
      </div>

      {/* Message */}
      <div style={{ background: "rgba(0,0,0,0.42)", borderRadius: 8, padding: "8px 14px", marginBottom: 6, fontSize: 12.5, textAlign: "center", minHeight: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {message}
      </div>

      {/* Hand */}
      <div style={{ background: "linear-gradient(180deg,rgba(255,255,255,0.035),rgba(0,0,0,0.36))", borderRadius: 16, padding: "12px 10px 14px", marginBottom: 10, border: isMyTurn ? `1.5px solid rgba(212,175,55,${pulse ? 0.82 : 0.42})` : "1px solid rgba(212,175,55,0.14)", boxShadow: isMyTurn && pulse ? "0 0 18px rgba(212,175,55,0.22)" : "0 10px 22px rgba(0,0,0,0.18)", transition: "border-color 0.4s, box-shadow 0.4s", touchAction: "pan-y pinch-zoom" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 11, opacity: 0.5, letterSpacing: 1, display: "flex", gap: 8, alignItems: "center" }}>
            {human.name}'s HAND ({human.hand.length})
            {human.hasComDown && <span style={{ color: "#4ade80", fontSize: 10, fontWeight: 700 }}>✓ DOWN</span>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {isMyTurn && <span style={{ fontSize: 11, color: pulse ? "#fbbf24" : "#f59e0b", fontWeight: 800, transition: "color 0.4s" }}>YOUR TURN</span>}
            <Btn onClick={sortHand} small>Sort</Btn>
          </div>
        </div>

        <div onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
          style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", marginBottom: 12, minHeight: 80, alignItems: "flex-end", touchAction: "pan-y" }}>
          {human.hand.length === 0 ? (
            <div style={{ opacity: 0.25, fontSize: 13, display: "flex", alignItems: "center" }}>Hand is empty</div>
          ) : human.hand.map((c, i) => (
            <div key={c.id} data-ci={i} draggable
              onDragStart={e => onDragStart(e, c.id, i)}
              onDragOver={e => onDragOver(e, i)}
              onDrop={e => onDrop(e, i)}
              onDragEnd={onDragEnd}
              onTouchStart={e => onTouchStart(e, c.id, i)}
              style={{ outline: dragOver === i ? "2px solid #60a5fa" : "none", borderRadius: 6 }}>
              <CardView card={c} selected={selectedIds.includes(c.id)} selectedOrder={selectedIds.includes(c.id) ? selectedIds.indexOf(c.id) + 1 : null} onClick={() => tapCard(c.id)} dragging={dragRef.current.id === c.id} />
            </div>
          ))}
        </div>

        <div style={{ textAlign: "center", fontSize: 10, opacity: 0.28, marginBottom: isMyTurn ? 4 : 8 }}>↔ Drag to reorder · Tap to select</div>

        {/* Sticky action buttons — always visible at bottom */}
        {isMyTurn && (
          <div style={{ position: "relative", background: "rgba(8,10,16,0.96)", border: "1px solid rgba(212,175,55,0.32)", borderRadius: 14, padding: "10px 8px", margin: "8px 0 0", display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", zIndex: 5, maxWidth: "100%", boxShadow: "0 8px 20px rgba(0,0,0,0.28)" }}>
            {phase === "draw" && (
              <React.Fragment>
                <Btn onClick={drawFromDeck} bg="#16a34a">🎴 Pick Up</Btn>
                <Btn onClick={drawFromDiscard} disabled={!topDiscard} bg="#2563eb">↩ Pick Up Throw</Btn>
              </React.Fragment>
            )}
            {phase === "play" && (
              <React.Fragment>
                <Btn onClick={playSet} bg="#7c3aed">▶ Play Set</Btn>
                <Btn onClick={toggleAdd} disabled={!human.hasComDown} bg="#ea580c" active={addMode}>{addMode ? "✕ Cancel" : "➕ Add to Set"}</Btn>
                <Btn onClick={doDiscard} bg="#dc2626">🗑 Throw</Btn>
              </React.Fragment>
            )}
            {phase === "recall" && game.recallBy === 0 && (
              <React.Fragment>
                <Btn onClick={recallWild} bg="#f59e0b">↩ Recall Joker/Wild</Btn>
                <span style={{ fontSize: 11, opacity: 0.65, alignSelf: "center" }}>5 sec window</span>
              </React.Fragment>
            )}
          </div>
        )}

        {isMyTurn && phase === "play" && !human.hasComDown && (
          <div style={{ marginTop: 8, textAlign: "center", fontSize: 11, opacity: 0.4 }}>
            Select 4+ consecutive same-suit cards → <strong>Play Set</strong> to come down<br/>
            <span style={{ opacity: 0.7 }}>Or select 7+ cards (4-run + 3-run) to come down with both sets at once!</span>
          </div>
        )}
        {selCards.length > 0 && phase === "play" && (
          <div style={{ marginTop: 6, textAlign: "center", fontSize: 11, opacity: 0.55 }}>
            {selCards.length} selected · {validMeld(selCards) ? <span style={{ color: "#4ade80" }}>✓ Valid set</span> : <span style={{ color: "#f87171" }}>✗ Not valid yet</span>}
          </div>
        )}
        {addMode && selCards.length === 1 && (
          <div style={{ marginTop: 6, textAlign: "center", fontSize: 11, color: "#fbbf24", opacity: 0.7 }}>
            Click a table set ↑ to place {selCards[0].rank}{selCards[0].suit !== "★" ? selCards[0].suit : "🃏"}
          </div>
        )}
        {addMode && selCards.length !== 1 && (
          <div style={{ marginTop: 6, textAlign: "center", fontSize: 11, color: "#fbbf24", opacity: 0.5 }}>Select exactly 1 card to add to a set</div>
        )}
      </div>

      <div style={{ textAlign: "center", fontSize: 10, opacity: 0.22, marginTop: 8, paddingBottom: 4 }}>
        {wildRank} rank + Jokers are wild · 6 Jokers in play
      </div>
    </div>
  );
}

// ─── Watermark ───────────────────────────────────────────────
function Watermark() {
  return (
    <a href="mailto:bhojasanvir@gmail.com" style={{
      position: "fixed", top: 8, right: 10, zIndex: 9999,
      fontSize: 10, color: "rgba(255,255,255,0.28)", textDecoration: "none",
      fontFamily: "Georgia,serif", letterSpacing: 0.5,
      transition: "opacity .2s",
    }}
    onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,0.65)"}
    onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.28)"}>
      ✦ Created by Sanvir Bhoja
    </a>
  );
}

function getOnlineJoinUrl(roomCode) {
  const code = String(roomCode || "").toUpperCase();
  const isAppShell = window.location.protocol === "capacitor:" || window.location.hostname === "localhost";
  const base = isAppShell
    ? "https://shivs9card-production.up.railway.app/"
    : `${window.location.origin}${window.location.pathname}`;
  return `${base}?join=${encodeURIComponent(code)}`;
}

function shareJoinLink(roomCode) {
  const url = getOnlineJoinUrl(roomCode);
  if (navigator.share) {
    navigator.share({ title: "Join my 9 Card game!", text: `Join room ${roomCode}`, url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url);
    alert("Join link copied! Share it with friends.");
  }
}

// ─── Online Lobby ─────────────────────────────────────────────
function OnlineLobby({ onBack, onJoinedRoom, onGameStart }) {
  // Pre-fill join code from URL param ?join=XXXXX
  const urlJoinCode = new URLSearchParams(window.location.search).get("join") || "";
  const cleanUrlJoinCode = urlJoinCode.trim().toUpperCase();
  const [view, setView] = useState(cleanUrlJoinCode ? "join" : "menu"); // menu | create | join | waiting
  const [playerName, setPlayerName] = useState(() => localStorage.getItem("shiv9_name") || "");
  const [joinCode, setJoinCode] = useState(cleanUrlJoinCode);
  const [roomCode, setRoomCode] = useState("");
  const [roomPlayers, setRoomPlayers] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [error, setError] = useState("");
  const [socket, setSocket] = useState(null);
  const [selectedTheme, setSelectedTheme] = useState("shivaan");

  const gameStartedRef = useRef(false);
  const roomCodeRef = useRef("");

  useEffect(() => {
    const isCapacitor = window.location.protocol === "capacitor:" || window.location.hostname === "localhost";
    const SERVER = isCapacitor
      ? "https://shivs9card-production.up.railway.app"
      : (import.meta.env.VITE_SERVER_URL || window.location.origin);
    const s = io(SERVER, { transports: ["websocket", "polling"] });
    setSocket(s);

    s.on("room_joined", ({ code, room, isHost: iH, playerToken, playerName: joinedName }) => {
      const safeJoinedName = joinedName || playerName || sessionStorage.getItem("shiv9_name") || localStorage.getItem("shiv9_name") || "";
      roomCodeRef.current = code;
      sessionStorage.setItem("shiv9_room", code);
      localStorage.setItem("shiv9_room", code);
      if (safeJoinedName) { sessionStorage.setItem("shiv9_name", safeJoinedName); localStorage.setItem("shiv9_name", safeJoinedName); setPlayerName(safeJoinedName); }
      if (playerToken) { sessionStorage.setItem("shiv9_token", playerToken); localStorage.setItem("shiv9_token", playerToken); }
      setRoomCode(code);
      setRoomPlayers(room.players);
      setIsHost(iH);
      setView("waiting");
    });

    s.on("room_updated", (payload) => {
      const room = payload?.room || payload;
      setRoomPlayers(room?.players || []);
    });
    s.on("theme_changed", ({ theme }) => { setCardTheme(theme); setSelectedTheme(theme); });
    s.on("deal_start", ({ playerNames }) => {
      gameStartedRef.current = true;
      onGameStart({ socket: s, playerNames, roomCode: roomCodeRef.current });
    });
    s.on("game_state", (state) => {
      // If a player rejoins a game already in progress, move straight back into the game screen.
      if (!gameStartedRef.current && roomCodeRef.current) {
        gameStartedRef.current = true;
        onGameStart({
          socket: s,
          playerNames: (state.players || []).map(p => p.name),
          roomCode: roomCodeRef.current,
        });
      }
    });
    s.on("error", (msg) => setError(msg));

    return () => { if (!gameStartedRef.current) s.disconnect(); };
  }, []);

  const inp = { width: "100%", padding: "11px 14px", borderRadius: 9, fontSize: 15, fontWeight: 600, background: "rgba(255,255,255,0.1)", border: "1.5px solid rgba(255,255,255,0.3)", color: "#fff", outline: "none", boxSizing: "border-box" };
  const BG = "radial-gradient(ellipse at 50% 30%,#1b6b3a 0%,#072515 100%)";

  if (view === "menu") {
    const savedCode = sessionStorage.getItem("shiv9_room") || localStorage.getItem("shiv9_room");
    const savedName = sessionStorage.getItem("shiv9_name") || localStorage.getItem("shiv9_name");
    const savedToken = sessionStorage.getItem("shiv9_token") || localStorage.getItem("shiv9_token");
    return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Georgia,serif", padding: 24 }}>
      <div style={{ fontSize: 52, marginBottom: 8 }}>🃏</div>
      <h1 style={{ fontSize: 34, fontWeight: 900, letterSpacing: 3, marginBottom: 4, textAlign: "center" }}>Shivaan's 9 Card</h1>
      <p style={{ opacity: 0.45, marginBottom: 40, fontSize: 13, letterSpacing: 2 }}>ONLINE MULTIPLAYER</p>
      <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 14 }}>
        <button onClick={() => setView("create")} style={{ padding: "14px", borderRadius: 12, fontSize: 16, fontWeight: 800, background: "#16a34a", color: "#fff", border: "none", cursor: "pointer" }}>🏠 Create a Game</button>
        <button onClick={() => setView("join")}   style={{ padding: "14px", borderRadius: 12, fontSize: 16, fontWeight: 800, background: "#2563eb", color: "#fff", border: "none", cursor: "pointer" }}>🔗 Join with Code</button>
        {savedCode && savedName && (
          <button onClick={() => {
            roomCodeRef.current = savedCode;
            setRoomCode(savedCode);
            setPlayerName(savedName);
            setError("");
            socket?.emit("rejoin_room", { code: savedCode, playerName: savedName, playerToken: savedToken || "" });
          }} style={{ padding: "14px", borderRadius: 12, fontSize: 15, fontWeight: 800, background: "#7c3aed", color: "#fff", border: "none", cursor: "pointer" }}>
            🔄 Rejoin {savedCode} as {savedName}
          </button>
        )}
        <button onClick={onBack} style={{ padding: "14px", borderRadius: 12, fontSize: 14, fontWeight: 700, background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }}>← Back</button>
      </div>
    </div>
  );}

  if (view === "create" || view === "join") return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Georgia,serif", padding: 24 }}>
      <h2 style={{ fontSize: 24, fontWeight: 900, marginBottom: 28, letterSpacing: 2 }}>{view === "create" ? "🏠 Create Game" : "🔗 Join Game"}</h2>
      <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 11, opacity: 0.45, marginBottom: 5, letterSpacing: 1 }}>YOUR NAME</div>
          <input style={inp} placeholder="Enter your name" value={playerName} maxLength={16} onChange={e => setPlayerName(e.target.value)} />
        </div>
        {view === "join" && (
          <div>
            <div style={{ fontSize: 11, opacity: 0.45, marginBottom: 5, letterSpacing: 1 }}>ROOM CODE</div>
            <input style={{ ...inp, textTransform: "uppercase", letterSpacing: 4, fontSize: 20 }} placeholder="XXXXX" value={joinCode} maxLength={5} onChange={e => setJoinCode(e.target.value.toUpperCase())} />
          </div>
        )}
        {error && <div style={{ color: "#f87171", fontSize: 13, textAlign: "center" }}>❌ {error}</div>}
        <button onClick={() => {
          if (!playerName.trim()) { setError("Enter your name first"); return; }
          setError("");
          if (view === "create") socket?.emit("create_room", { playerName: playerName.trim() });
          else { if (!joinCode) { setError("Enter a room code"); return; } socket?.emit("join_room", { code: joinCode, playerName: playerName.trim(), playerToken: localStorage.getItem("shiv9_token") || sessionStorage.getItem("shiv9_token") || "" }); }
        }} style={{ padding: "14px", borderRadius: 12, fontSize: 16, fontWeight: 800, background: view === "create" ? "#16a34a" : "#2563eb", color: "#fff", border: "none", cursor: "pointer" }}>
          {view === "create" ? "Create Room" : "Join Room"}
        </button>
        <button onClick={() => { setView("menu"); setError(""); }} style={{ padding: "10px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)", border: "none", cursor: "pointer" }}>← Back</button>
      </div>
    </div>
  );

  if (view === "waiting") {
    const shareUrl = getOnlineJoinUrl(roomCode);
    return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Georgia,serif", padding: 24 }}>
      <h2 style={{ fontSize: 22, fontWeight: 900, marginBottom: 6 }}>Waiting Room</h2>
      <div style={{ fontSize: 28, fontWeight: 900, color: "#fbbf24", letterSpacing: 6, marginBottom: 4 }}>{roomCode}</div>
      <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 6 }}>Share this code with friends</div>

      {/* Share link button */}
      <button onClick={() => shareJoinLink(roomCode)} style={{ marginBottom: 24, padding: "7px 18px", borderRadius: 20, fontSize: 12, fontWeight: 700, background: "rgba(37,99,235,0.3)", color: "#93c5fd", border: "1px solid rgba(37,99,235,0.4)", cursor: "pointer" }}>
        🔗 Share Join Link
      </button>

      {/* Players list with ready status */}
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        {roomPlayers.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(0,0,0,0.28)", borderRadius: 10, padding: "10px 14px", marginBottom: 8, border: `1px solid ${p.ready ? "rgba(74,222,128,0.3)" : "rgba(255,255,255,0.06)"}` }}>
            <span style={{ fontSize: 18 }}>{i === 0 ? "👑" : "👤"}</span>
            <span style={{ fontWeight: 600, flex: 1 }}>{p.name}</span>
            <span style={{ fontSize: 11, color: p.ready ? "#4ade80" : "rgba(255,255,255,0.3)" }}>{p.ready ? "✓ Ready" : "Not ready"}</span>
          </div>
        ))}
        {roomPlayers.length < 4 && (
          <div style={{ textAlign: "center", opacity: 0.25, fontSize: 12, fontStyle: "italic", padding: "8px 0" }}>
            Waiting for players… ({roomPlayers.length}/4)
          </div>
        )}
      </div>

      {/* Card theme picker — host only */}
      {isHost && (
        <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
          <div style={{ fontSize: 11, opacity: 0.45, letterSpacing: 1, marginBottom: 8, textAlign: "center" }}>CARD BACK THEME</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            {Object.entries(CARD_THEME_LABELS).map(([key, label]) => (
              <button key={key} onClick={() => {
                setCardTheme(key);
                setSelectedTheme(key);
                socket?.emit("set_theme", { code: roomCode, theme: key });
              }} style={{
                flex: 1, padding: "10px 6px", borderRadius: 10, fontSize: 11, fontWeight: 700,
                background: selectedTheme === key ? "rgba(251,191,36,0.24)" : "rgba(255,255,255,0.07)",
                color: selectedTheme === key ? "#fbbf24" : "rgba(255,255,255,0.5)",
                border: selectedTheme === key ? "2px solid #fbbf24" : "1px solid rgba(255,255,255,0.1)",
                boxShadow: selectedTheme === key ? "0 0 18px rgba(251,191,36,0.45)" : "none",
                transform: selectedTheme === key ? "translateY(-2px) scale(1.03)" : "none",
                cursor: "pointer",
              }}>{label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Ready / Start buttons */}
      {isHost ? (
        <button disabled={roomPlayers.length < 2 || !roomPlayers.filter(p => !p.isHost).every(p => p.ready)}
          onClick={() => socket?.emit("start_game", { code: roomCode })}
          style={{ padding: "14px 48px", borderRadius: 12, fontSize: 16, fontWeight: 800, background: (roomPlayers.length >= 2 && roomPlayers.filter(p=>!p.isHost).every(p=>p.ready)) ? "#16a34a" : "rgba(255,255,255,0.1)", color: (roomPlayers.length >= 2 && roomPlayers.filter(p=>!p.isHost).every(p=>p.ready)) ? "#fff" : "rgba(255,255,255,0.3)", border: "none", cursor: (roomPlayers.length >= 2 && roomPlayers.filter(p=>!p.isHost).every(p=>p.ready)) ? "pointer" : "not-allowed" }}>
          {roomPlayers.filter(p=>!p.isHost).every(p=>p.ready) ? `▶ Start Game (${roomPlayers.length} players)` : `Waiting for everyone… (${roomPlayers.filter(p=>p.ready).length}/${roomPlayers.length} ready)`}
        </button>
      ) : (
        <button onClick={() => socket?.emit("player_ready", { code: roomCode })}
          style={{ padding: "14px 48px", borderRadius: 12, fontSize: 16, fontWeight: 800, background: roomPlayers.find(p => p.socketId === socket?.id)?.ready ? "#16a34a" : "#2563eb", color: "#fff", border: "none", cursor: "pointer" }}>
          {roomPlayers.find(p => p.socketId === socket?.id)?.ready ? "✓ You're Ready!" : "✋ I'm Ready"}
        </button>
      )}
    </div>
  );}


  return null;
}

// ─── Mode Selection (home screen) ─────────────────────────────
// ─── Game Logo ───────────────────────────────────────────────
function GameLogo() {
  return (
    <svg width="100%" viewBox="0 0 680 230" style={{ maxWidth: 520, display: "block", margin: "0 auto" }}>
      <rect x="0" y="0" width="680" height="230" rx="20" fill="#0f3d22"/>
      {/* Stacked cards left */}
      <rect x="28" y="55" width="72" height="100" rx="6" fill="#fffef2" stroke="#c8b87a" strokeWidth="1.5" transform="rotate(-15,64,105)"/>
      <rect x="40" y="50" width="72" height="100" rx="6" fill="#fffef2" stroke="#c8b87a" strokeWidth="1.5" transform="rotate(-7,76,100)"/>
      <rect x="52" y="46" width="72" height="100" rx="6" fill="#fffef2" stroke="#c8b87a" strokeWidth="2"/>
      <text x="59" y="71" fontFamily="Georgia,serif" fontSize="17" fontWeight="bold" fill="#dc2626">9</text>
      <text x="59" y="87" fontFamily="Georgia,serif" fontSize="13" fill="#dc2626">♥</text>
      <text x="88" y="66" fontFamily="Georgia,serif" fontSize="24" fill="#dc2626" textAnchor="middle">♥</text>
      {/* Shivaan card right */}
      <rect x="500" y="18" width="150" height="200" rx="12" fill="#000" opacity="0.25" transform="translate(3,3)"/>
      <rect x="500" y="18" width="150" height="200" rx="12" fill="#fffef2" stroke="#fbbf24" strokeWidth="2.5"/>
      <image href="/shivaan.png" x="500" y="18" width="150" height="200" clipPath="url(#logoClip)" preserveAspectRatio="xMidYMid slice"/>
      <defs><clipPath id="logoClip"><rect x="500" y="18" width="150" height="200" rx="12"/></clipPath></defs>
      {/* Title */}
      <text x="300" y="94" textAnchor="middle" fontFamily="Georgia,serif" fontSize="36" fontWeight="bold" fill="#fbbf24" letterSpacing="1">Shivaan's</text>
      <text x="296" y="152" textAnchor="middle" fontFamily="Georgia,serif" fontSize="66" fontWeight="bold" fill="#ffffff" letterSpacing="-2">9 Card</text>
      {/* Suits */}
      <text x="214" y="182" textAnchor="middle" fontFamily="Georgia,serif" fontSize="15" fill="#dc2626">♥</text>
      <text x="240" y="182" textAnchor="middle" fontFamily="Georgia,serif" fontSize="15" fill="#e5e7eb">♠</text>
      <text x="266" y="182" textAnchor="middle" fontFamily="Georgia,serif" fontSize="15" fill="#dc2626">♦</text>
      <text x="292" y="182" textAnchor="middle" fontFamily="Georgia,serif" fontSize="15" fill="#e5e7eb">♣</text>
      <text x="318" y="182" textAnchor="middle" fontFamily="Georgia,serif" fontSize="14" fill="#a78bfa">🃏</text>
      {/* Tagline */}
      <text x="296" y="208" textAnchor="middle" fontFamily="Georgia,serif" fontSize="12" fill="#4ade80" letterSpacing="2">Built by his dad, just for him</text>
      {/* Gold border */}
      <rect x="1" y="1" width="678" height="228" rx="20" fill="none" stroke="#fbbf24" strokeWidth="1" opacity="0.3"/>
    </svg>
  );
}

// ─── Recent Games Screen ──────────────────────────────────────
function RecentGamesScreen({ onClose }) {
  const [games, setGames] = useState(null);
  const BG = "radial-gradient(ellipse at 50% 30%,#1b6b3a 0%,#072515 100%)";

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE_URL}/api/recent-games?player=${encodeURIComponent(localStorage.getItem("shiv9_name") || "")}`).then(r => r.json()).catch(() => []),
      Promise.resolve(JSON.parse(localStorage.getItem("shiv9_recent_games") || "[]")),
    ])
      .then(([serverGames, localGames]) => {
        const all = [...localGames, ...serverGames];
        const seen = new Set();
        setGames(all.filter(g => {
          const key = `${g.date}|${g.winner}|${g.rounds}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 5));
      })
      .catch(() => setGames(JSON.parse(localStorage.getItem("shiv9_recent_games") || "[]")));
  }, []);

  function timeAgo(iso) {
    const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  const medals = ["🥇", "🥈", "🥉", "4.", "5."];

  return (
    <div style={{ minHeight: "100svh", background: BG, display: "flex", flexDirection: "column", alignItems: "center", color: "#fff", fontFamily: "Georgia,serif", padding: 24, overflowY: "auto" }}>
      <div style={{ fontSize: 48, marginBottom: 8 }}>🏆</div>
      <h1 style={{ fontSize: 28, fontWeight: 900, letterSpacing: 2, marginBottom: 4 }}>Recent Games</h1>
      <p style={{ opacity: 0.45, marginBottom: 28, fontSize: 12, letterSpacing: 2 }}>LAST 5 ONLINE SERIES</p>

      {games === null && <div style={{ opacity: 0.5 }}>Loading…</div>}
      {games?.length === 0 && (
        <div style={{ opacity: 0.4, textAlign: "center", marginTop: 40 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🎴</div>
          No completed games yet.<br />Finish a series to see it here!
        </div>
      )}

      <div style={{ width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", gap: 14 }}>
        {games?.map((g, i) => (
          <div key={i} style={{ background: "rgba(0,0,0,0.35)", borderRadius: 14, padding: "14px 18px", border: "1px solid rgba(255,255,255,0.08)" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 11, opacity: 0.45, letterSpacing: 1 }}>{timeAgo(g.date)}</span>
              <span style={{ fontSize: 11, opacity: 0.45 }}>{g.rounds} round{g.rounds !== 1 ? "s" : ""}</span>
            </div>
            {/* Players */}
            {g.players.map((p, j) => (
              <div key={j} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "6px 0",
                borderBottom: j < g.players.length - 1 ? "1px solid rgba(255,255,255,0.06)" : "none",
              }}>
                <span style={{ fontSize: 18, minWidth: 28 }}>{medals[j] || `${j+1}.`}</span>
                <span style={{ flex: 1, fontWeight: j === 0 ? 700 : 400 }}>{p.name}</span>
                {p.wins > 0 && <span style={{ fontSize: 11, color: "#fbbf24" }}>{"⭐".repeat(Math.min(p.wins, 5))}</span>}
                <span style={{ fontWeight: 700, color: j === 0 ? "#4ade80" : "#fff", fontSize: 15 }}>
                  {p.total}pts
                </span>
              </div>
            ))}
            {/* Winner banner */}
            <div style={{ marginTop: 8, fontSize: 11, color: "#4ade80", opacity: 0.7 }}>
              🏆 {g.winner} won this series
            </div>
          </div>
        ))}
      </div>

      <button onClick={onClose} style={{ marginTop: 28, padding: "12px 36px", borderRadius: 12, fontSize: 15, fontWeight: 700, background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }}>
        ← Back
      </button>
    </div>
  );
}

// ─── Mode Select ─────────────────────────────────────────────
function ModeSelect({ onOffline, onOnline, onRecentGames }) {
  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(ellipse at 50% 30%,#1b6b3a 0%,#072515 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Georgia,serif", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 520, marginBottom: 32 }}>
        <GameLogo />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: 320 }}>
        <button onClick={onOnline} style={{ padding: "16px", borderRadius: 14, fontSize: 17, fontWeight: 800, background: "linear-gradient(135deg,#1d4ed8,#2563eb)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 4px 18px rgba(37,99,235,0.4)" }}>
          🌐 Play Online<br /><span style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>Multiplayer with friends</span>
        </button>
        <button onClick={onOffline} style={{ padding: "16px", borderRadius: 14, fontSize: 17, fontWeight: 800, background: "linear-gradient(135deg,#15803d,#16a34a)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 4px 18px rgba(22,163,74,0.4)" }}>
          🤖 Play Offline<br /><span style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>vs CPU opponents</span>
        </button>
        <button onClick={onRecentGames} style={{ padding: "14px", borderRadius: 14, fontSize: 16, fontWeight: 800, background: "linear-gradient(135deg,#92400e,#b45309)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 4px 18px rgba(180,83,9,0.4)" }}>
          🏆 Recent Games<br /><span style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>Games you completed</span>
        </button>
        <button onClick={() => alert("HOW TO PLAY\n\n• Pick up from the deck or throw pile.\n• First come-down must be 4+ cards, or two sets at once with 4+ and 3+.\n• Runs must be same suit and consecutive.\n• Jokers/wild cards follow the order you select them.\n• Donkey sets are same-number sets. Jokers can fill missing suits once all 4 suits are represented.\n• Throw one card to end your turn.\n• Lowest score wins the series.")} style={{ padding: "12px", borderRadius: 14, fontSize: 15, fontWeight: 800, background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }}>
          ❔ How to Play
        </button>
        <div style={{ textAlign: "center", opacity: 0.35, fontSize: 11, marginTop: 2 }}>{APP_VERSION}</div>
      </div>
    </div>
  );
}

// ─── Online Game Screen ────────────────────────────────────────
// ─── Chat ────────────────────────────────────────────────────
function ChatChat({ socket, roomCode, playerName, headerMode = false }) {
  const [open, setOpen]       = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput]     = useState("");
  const [unread, setUnread]   = useState(0);
  const bottomRef = useRef(null);
  const EMOJIS = ["😂","👀","💀","🔥","😤","🎉","😬","💰","🤦","👑"];

  useEffect(() => {
    if (!socket) return;
    function onMsg(msg) {
      setMessages(prev => [...prev.slice(-49), msg]);
      if (!open) setUnread(u => u + 1);
    }
    function onSystem(msg) {
      setMessages(prev => [...prev.slice(-49), { system: true, message: msg.text || msg.message || "System update", timestamp: msg.ts || Date.now() }]);
      if (!open) setUnread(u => u + 1);
    }
    socket.off("chat_message", onMsg);
    socket.off("system_message", onSystem);
    socket.on("chat_message", onMsg);
    socket.on("system_message", onSystem);
    return () => { socket.off("chat_message", onMsg); socket.off("system_message", onSystem); };
  }, [socket, open]);

  useEffect(() => {
    if (open) { setUnread(0); setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50); }
  }, [open, messages.length]);

  function send(msg) {
    if (!msg.trim() || !socket) return;
    socket.emit("chat_message", { code: roomCode, playerName, message: msg.trim() });
    setInput("");
  }

  return (
    <>
      {/* Header / floating chat button */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Chat"
        style={headerMode ? {
          position: "relative", zIndex: 20,
          width: 42, height: 38, borderRadius: 14,
          background: open ? "rgba(124,58,237,0.95)" : "rgba(15,23,42,0.92)",
          border: "1px solid rgba(212,175,55,0.45)",
          color: "#fff", fontSize: 18, cursor: "pointer",
          boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.2s", flexShrink: 0,
        } : {
          position: "fixed", top: "calc(10px + env(safe-area-inset-top))", right: 10, zIndex: 9999,
          width: 50, height: 50, borderRadius: "50%",
          background: open ? "#7c3aed" : "#1d4ed8",
          border: "2px solid rgba(255,255,255,0.15)",
          color: "#fff", fontSize: 22, cursor: "pointer",
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.2s",
        }}>
        💬
        {unread > 0 && !open && (
          <div style={{
            position: "absolute", top: -4, right: -4,
            background: "#ef4444", color: "#fff", borderRadius: "50%",
            width: 18, height: 18, fontSize: 10, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>{unread}</div>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div style={{
          position: "fixed", top: headerMode ? "calc(72px + env(safe-area-inset-top))" : "calc(62px + env(safe-area-inset-top))", right: 10, zIndex: 9998,
          width: Math.min(320, window.innerWidth - 22),
          maxHeight: Math.min(430, window.innerHeight - 110), background: "rgba(10,20,35,0.98)",
          border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16,
          display: "flex", flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
          fontFamily: "Georgia,serif", overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>💬 Chat</span>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
            {messages.length === 0 && (
              <div style={{ textAlign: "center", opacity: 0.3, fontSize: 12, marginTop: 24, lineHeight: 1.8 }}>
                No messages yet…<br />Start chatting! 💬
              </div>
            )}
            {messages.map((m, i) => {
              if (m.system) {
                return (
                  <div key={i} style={{ alignSelf: "center", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.22)", color: "#fbbf24", borderRadius: 999, padding: "5px 10px", fontSize: 11, fontWeight: 700, textAlign: "center", maxWidth: "92%" }}>
                    {m.message}
                  </div>
                );
              }
              const isMe = m.playerName === playerName;
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                  <div style={{ fontSize: 9, opacity: 0.4, marginBottom: 2, color: "#fff" }}>{m.playerName}</div>
                  <div style={{
                    background: isMe ? "#7c3aed" : "rgba(255,255,255,0.1)",
                    color: "#fff", borderRadius: 10,
                    padding: "6px 10px", fontSize: 13,
                    maxWidth: "85%", wordBreak: "break-word", lineHeight: 1.4,
                  }}>
                    {m.message}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Quick emoji row */}
          <div style={{ padding: "6px 10px", display: "flex", gap: 4, flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
            {EMOJIS.map(e => (
              <button key={e} onClick={() => send(e)} style={{
                background: "none", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8, padding: "2px 6px", fontSize: 16,
                cursor: "pointer", color: "#fff", lineHeight: 1.4,
              }}>{e}</button>
            ))}
          </div>

          {/* Input row */}
          <div style={{ padding: "8px 10px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 8, flexShrink: 0 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && send(input)}
              placeholder="Say something..."
              style={{
                flex: 1, background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8,
                padding: "7px 10px", color: "#fff", fontSize: 13,
                fontFamily: "Georgia,serif", outline: "none",
              }}
            />
            <button onClick={() => send(input)} style={{
              background: "#7c3aed", border: "none", borderRadius: 8,
              color: "#fff", fontSize: 18, padding: "0 12px", cursor: "pointer",
            }}>↑</button>
          </div>
        </div>
      )}
    </>
  );
}

function OnlineGameScreen({ socket, series, onEnd, onRoundEnd }) {
  const [serverGame, setServerGame] = useState(null);
  const [series_, setSeries_] = useState(series);
  const [ui, setUi] = useState({
    selectedIds: [], addMode: false, placementIdx: null,
    wildConfirmed: false, message: "🎮 Connecting…",
    handOrderIds: null, // tracks manual hand sort order
    winnerAnnouncement: null,
    soundOn: localStorage.getItem("shiv9_sound") !== "off",
    connectionStatus: "connected",
    moveHistory: [],
  });
  const [dcNotice, setDcNotice]   = useState(null); // { name, seconds } — another player dropped
  const [gameEnded, setGameEnded] = useState(null); // reason string — game was force-ended
  const roomCodeRef   = useRef(series?.roomCode || "");
  const onRoundEndRef = useRef(onRoundEnd);
  // Always keep ref current — prevents stale closure score bug
  useEffect(() => { onRoundEndRef.current = onRoundEnd; });

  useEffect(() => {
    if (series?.roomCode) roomCodeRef.current = series.roomCode;
    if (series) setSeries_(series);
  }, [series?.roomCode, series?.round]);

  // On entering the game screen, ask the server for the current state. After a
  // rejoin the game_state can arrive while we're still on the lobby screen, so
  // this screen may mount without it — request a fresh copy (with one retry).
  useEffect(() => {
    if (!socket) return;
    const pull = () => {
      const code = roomCodeRef.current || sessionStorage.getItem("shiv9_room") || localStorage.getItem("shiv9_room");
      if (code) socket.emit("request_state", { code });
    };
    pull();
    const t = setTimeout(pull, 900);
    return () => clearTimeout(t);
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    const reconnectToRoom = () => {
      setUi(u => ({ ...u, connectionStatus: "reconnecting" }));
      const code = roomCodeRef.current || sessionStorage.getItem("shiv9_room") || localStorage.getItem("shiv9_room");
      const name = sessionStorage.getItem("shiv9_name") || localStorage.getItem("shiv9_name");
      const token = sessionStorage.getItem("shiv9_token") || localStorage.getItem("shiv9_token");
      if (code && name) socket.emit("rejoin_room", { code, playerName: name, playerToken: token || "" });
    };
    const onDisconnect = () => setUi(u => ({ ...u, connectionStatus: "reconnecting" }));
    const onRoomJoined = ({ code, playerToken } = {}) => {
      if (code) { sessionStorage.setItem("shiv9_room", code); localStorage.setItem("shiv9_room", code); }
      if (playerToken) { sessionStorage.setItem("shiv9_token", playerToken); localStorage.setItem("shiv9_token", playerToken); }
      setUi(u => ({ ...u, connectionStatus: "rejoined" }));
    };
    socket.on("connect", reconnectToRoom);
    socket.on("disconnect", onDisconnect);
    socket.on("room_joined", onRoomJoined);
    socket.io?.on?.("reconnect", reconnectToRoom);
    return () => {
      socket.off("connect", reconnectToRoom);
      socket.off("disconnect", onDisconnect);
      socket.off("room_joined", onRoomJoined);
      socket.io?.off?.("reconnect", reconnectToRoom);
    };
  }, [socket, series_?.players]);

  useEffect(() => {
    if (!socket) return;

    // Use named handlers so cleanup removes ONLY these, not all listeners
    function onGameState(state) {
      const myI = state.myPlayerIdx ?? 0;
      setServerGame(prev => {
        if (prev && prev.currentPlayer !== myI &&
            state.currentPlayer === myI &&
            state.phase === "draw" && !state.winner) {
          if (localStorage.getItem("shiv9_sound") !== "off") { Sounds.yourTurn(); navigator.vibrate?.(120); }
        }
        return state;
      });
      setUi(u => ({
        ...u,
        selectedIds: [], addMode: false, placementIdx: null, wildConfirmed: false,
        winnerAnnouncement: u.winnerAnnouncement,
        handOrderIds: u.handOrderIds
          ? [...u.handOrderIds.filter(id => state.players?.[myI]?.hand?.find(c => c.id === id)),
             ...((state.players?.[myI]?.hand || []).filter(c => !u.handOrderIds.includes(c.id)).map(c => c.id))]
          : null,
        connectionStatus: "connected",
        moveHistory: state.moveHistory || u.moveHistory || [],
        message: state.message || (state.phase === "draw"
          ? (state.currentPlayer === myI
              ? "🎮 Your turn! Pick Up a card."
              : (state.players?.[state.currentPlayer]?.name || "Opponent") + "'s turn…")
          : "Play a set, add to a set, or throw."),
      }));
    }

    function onRoundEndEvt({ winner, scores, wildWin }) {
      const winnerScore = (scores || []).find(s => s.id === winner) || (scores || [])[winner];
      setUi(u => ({ ...u, winnerAnnouncement: (winnerScore?.name || "Someone") + " wins this round! 🏆" }));
      setTimeout(() => {
        setUi(u => ({ ...u, winnerAnnouncement: null }));
        if (onRoundEndRef.current) onRoundEndRef.current({ winner, scores: scores || [], wildWin });
      }, 2500);
    }

    function onGameOver({ updatedSeries, reason }) {
      if (updatedSeries) setSeries_(updatedSeries);
      if (reason) { setDcNotice(null); setGameEnded(reason); }
    }
    function onPlayerDisconnected({ name, seconds }) {
      setDcNotice({ name: name || "A player", seconds: seconds || 30 });
    }
    function onPlayerReconnected() { setDcNotice(null); }

    socket.on("game_state", onGameState);
    socket.on("round_end",  onRoundEndEvt);
    function onActionError(msg) { setUi(u => ({ ...u, message: "❌ " + (msg || "Move blocked."), connectionStatus: "connected" })); }
    socket.on("game_over",  onGameOver);
    socket.on("action_error", onActionError);
    socket.on("player_disconnected", onPlayerDisconnected);
    socket.on("player_reconnected",  onPlayerReconnected);

    return () => {
      socket.off("game_state", onGameState);
      socket.off("round_end",  onRoundEndEvt);
      socket.off("game_over",  onGameOver);
      socket.off("action_error", onActionError);
      socket.off("player_disconnected", onPlayerDisconnected);
      socket.off("player_reconnected",  onPlayerReconnected);
    };
  }, [socket]);

  // Tick down the "waiting for X to reconnect" countdown
  useEffect(() => {
    if (!dcNotice || dcNotice.seconds <= 0) return;
    const t = setTimeout(() => setDcNotice(d => (d ? { ...d, seconds: d.seconds - 1 } : d)), 1000);
    return () => clearTimeout(t);
  }, [dcNotice]);

  function act(action, payload = {}) {
    socket?.emit("game_action", { code: roomCodeRef.current, action, payload });
  }

  if (!serverGame) return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(#1b6b3a,#072515)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Georgia,serif" }}>
      <div style={{ textAlign: "center" }}><div style={{ fontSize: 36, marginBottom: 12 }}>🃏</div><div style={{ opacity: 0.6 }}>Connecting…</div></div>
    </div>
  );

  const myIdx = serverGame.myPlayerIdx ?? 0;
  const origOrder = [myIdx, ...Array.from({ length: serverGame.players.length }, (_, i) => i).filter(i => i !== myIdx)];
  const newCurrentPlayer = origOrder.indexOf(serverGame.currentPlayer);

  // Build the hand for local player, applying saved sort order
  function buildHand(serverHand) {
    const visible = serverHand.map((c, ci) =>
      c.hidden ? { rank: "?", suit: "?", isWild: false, id: `h${myIdx}_${ci}`, hidden: true } : c
    );
    if (!ui.handOrderIds) return visible;
    const ordered = ui.handOrderIds.map(id => visible.find(c => c.id === id)).filter(Boolean);
    const extras = visible.filter(c => !ui.handOrderIds.includes(c.id));
    return [...ordered, ...extras];
  }

  const viewGame = {
    // Server state
    ...serverGame,
    // Computed overrides
    currentPlayer: newCurrentPlayer,
    winner: serverGame.winner !== null ? origOrder.indexOf(serverGame.winner) : null,
    players: origOrder.map((origIdx, newIdx) => ({
      ...serverGame.players[origIdx],
      id: newIdx,
      isAI: newIdx !== 0,
      hand: newIdx === 0
        ? buildHand(serverGame.players[origIdx].hand)
        : serverGame.players[origIdx].hand.map((c, ci) =>
            c.hidden ? { rank: "?", suit: "?", isWild: false, id: `h${origIdx}_${ci}`, hidden: true } : c),
    })),
    // Re-apply client UI (overrides any stale server fields)
    selectedIds: ui.selectedIds,
    addMode: ui.addMode,
    placementIdx: ui.placementIdx,
    wildConfirmed: ui.wildConfirmed,
    message: serverGame.message || ui.message,
  };

  function setGameProxy(updater) {
    // Online mode: only update local UI state (selection, messages, sort order)
    // All game-changing actions are sent via onAction directly from GameScreen
    setUi(prev => {
      const prevFull = { ...viewGame, selectedIds: prev.selectedIds, addMode: prev.addMode, message: prev.message };
      const next = typeof updater === "function" ? updater(prevFull) : updater;
      if (!next) return prev;

      // Detect sort (same cards, different order)
      const p0hand = prevFull.players?.[0]?.hand || [];
      const n0hand = next.players?.[0]?.hand || [];
      const newIds = n0hand.map(c => c.id);
      const oldIds = p0hand.map(c => c.id);
      const sameCards = newIds.length === oldIds.length && newIds.every(id => oldIds.includes(id));
      const orderChanged = sameCards && JSON.stringify(newIds) !== JSON.stringify(oldIds);

      return {
        selectedIds: next.selectedIds ?? [],
        addMode: next.addMode ?? false,
        placementIdx: next.placementIdx ?? null,
        wildConfirmed: next.wildConfirmed ?? false,
        message: next.message ?? prev.message,
        handOrderIds: orderChanged ? newIds : prev.handOrderIds,
        soundOn: prev.soundOn,
        connectionStatus: prev.connectionStatus,
        moveHistory: prev.moveHistory,
      };
    });
  }

  function saveRecentLocal(seriesToSave) {
    if (!seriesToSave?.players?.length) return;
    const sorted = [...seriesToSave.players]
      .map(p => ({ name: p.name, total: p.total || 0, wins: p.wins || 0 }))
      .sort((a, b) => a.total - b.total);
    const item = { date: new Date().toISOString(), rounds: seriesToSave.round || 0, players: sorted, winner: sorted[0]?.name || "Unknown" };
    const list = JSON.parse(localStorage.getItem("shiv9_recent_games") || "[]");
    localStorage.setItem("shiv9_recent_games", JSON.stringify([item, ...list].slice(0, 5)));
  }

  function handleEnd() {
    if (!window.confirm("End this game and save it to Recent Games?")) return;
    socket?.emit("player_exit", { code: roomCodeRef.current });
    if (series_ && series_.players) {
      saveRecentLocal(series_);
      socket?.emit("end_game", { code: roomCodeRef.current, series: series_, playerName: viewGame?.players?.[0]?.name });
    }
    onEnd();
  }

  return (
    <>
      {gameEnded && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.88)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "Georgia,serif", color: "#fff", padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 54, marginBottom: 14 }}>🏁</div>
          <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Game ended</div>
          <div style={{ fontSize: 14, opacity: 0.7, maxWidth: 320, marginBottom: 26 }}>{gameEnded}</div>
          <button onClick={onEnd} style={{ padding: "13px 40px", borderRadius: 12, fontSize: 16, fontWeight: 800, background: "#fbbf24", color: "#1c1c1c", border: "none", cursor: "pointer" }}>Back to menu</button>
        </div>
      )}
      {ui.winnerAnnouncement && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.75)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          fontFamily: "Georgia,serif", color: "#fff",
        }}>
          <div style={{ fontSize: 60, marginBottom: 16 }}>🏆</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: "#fbbf24", textAlign: "center", padding: "0 24px" }}>
            {ui.winnerAnnouncement}
          </div>
          <div style={{ fontSize: 13, opacity: 0.5, marginTop: 16 }}>Scores showing in a moment…</div>
        </div>
      )}
      {ui.connectionStatus !== "connected" && (
        <div style={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: ui.connectionStatus === "rejoined" ? "rgba(22,163,74,0.92)" : "rgba(245,158,11,0.95)", color: "#fff", borderRadius: 999, padding: "7px 14px", fontFamily: "Georgia,serif", fontSize: 12, fontWeight: 800, boxShadow: "0 4px 18px rgba(0,0,0,0.35)" }}>
          {ui.connectionStatus === "rejoined" ? "✅ Rejoined game" : " reconnecting… Trying to rejoin"}
        </div>
      )}
      {dcNotice && (
        <div style={{ position: "fixed", top: 44, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "rgba(245,158,11,0.96)", color: "#1c1c1c", borderRadius: 999, padding: "8px 16px", fontFamily: "Georgia,serif", fontSize: 12.5, fontWeight: 800, boxShadow: "0 4px 18px rgba(0,0,0,0.35)", textAlign: "center", maxWidth: "92vw" }}>
          ⚠️ {dcNotice.name} disconnected — waiting {Math.max(0, dcNotice.seconds)}s to rejoin…
        </div>
      )}
      <div style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: 0,
        zIndex: 9997,
        padding: "calc(8px + env(safe-area-inset-top)) 10px 8px",
        background: "linear-gradient(180deg,rgba(5,6,10,0.98),rgba(10,11,17,0.90))",
        borderBottom: "1px solid rgba(212,175,55,0.22)",
        boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
        backdropFilter: "blur(10px)",
        boxSizing: "border-box",
      }}>
        <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#f8d36f", fontSize: 22, flexShrink: 0 }}>☰</div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, background: "rgba(0,0,0,0.36)", border: "1px solid rgba(212,175,55,0.35)", borderRadius: 14, padding: "8px 10px" }}>
            <span style={{ fontSize: 10, opacity: 0.6, whiteSpace: "nowrap" }}>ROOM</span>
            <strong style={{ fontSize: 16, letterSpacing: 3, color: "#f8d36f", overflow: "hidden", textOverflow: "ellipsis" }}>{roomCodeRef.current}</strong>
            <button onClick={() => shareJoinLink(roomCodeRef.current)} style={{
              marginLeft: "auto", border: "none", borderRadius: 10, padding: "7px 10px",
              background: "linear-gradient(180deg,#2563eb,#1d4ed8)", color: "#fff",
              fontSize: 12, fontWeight: 900, cursor: "pointer", boxShadow: "0 4px 10px rgba(37,99,235,0.28)",
            }}>Share</button>
          </div>
          <ChatChat socket={socket} roomCode={roomCodeRef.current} playerName={viewGame?.players?.[0]?.name || "You"} headerMode />
          <button onClick={() => setUi(u => { const next = !u.soundOn; localStorage.setItem("shiv9_sound", next ? "on" : "off"); return { ...u, soundOn: next }; })} style={{
            width: 42, height: 38, border: "1px solid rgba(212,175,55,0.45)", borderRadius: 14,
            background: "rgba(15,23,42,0.92)", color: "#fff", fontSize: 17, fontWeight: 900, cursor: "pointer", flexShrink: 0,
          }}>{ui.soundOn ? "🔊" : "🔇"}</button>
          <button onClick={handleEnd} style={{
            width: 42, height: 38, border: "1px solid rgba(212,175,55,0.45)", borderRadius: 14,
            background: "rgba(92,45,45,0.92)", color: "#fff", fontSize: 17, fontWeight: 900, cursor: "pointer", flexShrink: 0,
          }}>🚪</button>
        </div>
      </div>
      <GameScreen game={viewGame} setGame={setGameProxy} series={series_} onEnd={handleEnd} onAction={act} />
    </>
  );
}

// ─── Root App ────────────────────────────────────────────────
// OfflineApp is renamed from the original App export
function OfflineApp({ onBack }) {
  const [screen, setScreen] = useState("setup");
  const [game, setGame] = useState(null);
  const [series, setSeries] = useState(null);

  function startSeries(n, names) {
    const s = initSeries(n, names);
    const g = initGame(n, names);
    setSeries(s);
    setGame(g);
    setScreen("dealing"); // Show deal animation first
  }

  // Detect round end
  useEffect(() => {
    if (screen !== "playing" || !game || game.winner === null) return;
    setSeries(s => applySeries(s, game.winner, game.players, game.wildWin || false));
    setScreen("roundOver");
  }, [game && game.winner, screen]);

  // AI turns + sounds for offline mode
  useEffect(() => {
    if (screen !== "playing" || !game || game.winner !== null) return;
    const p = game.players[game.currentPlayer];
    if (!p) return;
    if (!p.isAI && game.currentPlayer === 0) Sounds.yourTurn();
    if (!p.isAI) return;
    const t = setTimeout(() => {
      setGame(g => {
        if (!g || g.winner !== null || !g.players[g.currentPlayer].isAI) return g;
        return runAiTurn(g);
      });
    }, 1100);
    return () => clearTimeout(t);
  }, [game && game.currentPlayer, screen]);

  function nextRound() {
    const names = series.players.map(p => p.name);
    const g = initGame(series.n, names);
    setGame(g);
    setScreen("dealing"); // Deal animation before each round
  }

  function endGame() { setScreen("gameOver"); }

  if (screen === "setup") return <><SetupScreen onStart={startSeries} onBack={onBack} /><Watermark /></>;
  if (screen === "dealing") return <><DealScreen game={game} onDone={() => setScreen("playing")} /><Watermark /></>;
  if (screen === "roundOver") return <><RoundOverScreen series={series} onNext={nextRound} onEnd={endGame} /><Watermark /></>;
  if (screen === "gameOver") return <><GameOverScreen series={series} onNew={() => { setSeries(null); setGame(null); setScreen("setup"); }} onRecentGames={() => { /* offline has no recent games */ }} /><Watermark /></>;
  return <><GameScreen game={game} setGame={setGame} series={series} onEnd={endGame} /><Watermark /></>;
}

// ─── Root App with mode selection ────────────────────────────
export default function App() {
  const hasJoinLink = new URLSearchParams(window.location.search).has("join");
  const [mode, setMode] = useState(hasJoinLink ? "online" : "home");
  const [onlineData, setOnlineData] = useState(null);
  const [roundOverSeries, setRoundOverSeries] = useState(null);

  // Inject styles and lock portrait safely after mount
  useEffect(() => {
    if (!document.getElementById("shiv9-styles")) {
      const s = document.createElement("style");
      s.id = "shiv9-styles";
      s.textContent = SHIV9_STYLES;
      document.head.appendChild(s);
    }
    lockPortrait();
  }, []);

  // Save series and go home from online round-over
  function endOnlineGame(series) {
    if (series && onlineData?.socket) {
      onlineData.socket.emit("end_game", {
        code: onlineData.currentSeries?.roomCode || onlineData.roomCode,
        series,
      });
    }
    setMode("home"); setRoundOverSeries(null); setOnlineData(null);
  }

  // Listen for next-round deal_start while on the score screen
  useEffect(() => {
    if (!onlineData?.socket) return;
    const socket = onlineData.socket;
    const handler = () => { setRoundOverSeries(null); };
    socket.on("deal_start", handler);
    return () => socket.off("deal_start", handler);
  }, [onlineData?.socket]);

  if (roundOverSeries) return (
    <>
      <RoundOverScreen
        series={roundOverSeries}
        onNext={() => {
          onlineData?.socket?.emit("next_round", { code: onlineData?.currentSeries?.roomCode || onlineData?.roomCode });
          setRoundOverSeries(null);
        }}
        onEnd={() => endOnlineGame(roundOverSeries)}
        onRematch={() => {
          endOnlineGame(roundOverSeries);
          onlineData?.socket?.emit("rematch", { code: onlineData?.currentSeries?.roomCode || onlineData?.roomCode });
        }}
      />
      <Watermark />
    </>
  );

  if (mode === "recent") return <><RecentGamesScreen onClose={() => setMode("home")} /><Watermark /></>;

  if (mode === "home") return (
    <>
      <ModeSelect
        onOffline={() => setMode("offline")}
        onOnline={() => setMode("online")}
        onRecentGames={() => setMode("recent")}
      />
      <Watermark />
    </>
  );

  if (mode === "offline") return <OfflineApp onBack={() => setMode("home")} />;

  if (mode === "online") return (
    <>
      <OnlineLobby
        onBack={() => setMode("home")}
        onGameStart={({ socket, playerNames, roomCode }) => {
          setOnlineData({ socket, roomCode, playerNames });
          setMode("online_game");
        }}
      />
      <Watermark />
    </>
  );

  if (mode === "online_game" && onlineData) {
    function handleOnlineRoundEnd({ winner, scores, wildWin }) {
      setOnlineData(prev => {
        if (!prev) return prev;
        const gamePlayers = scores.map(s => ({
          id: s.id, name: s.name, hand: s.hand || [],
          hasComDown: s.hasComDown === true,
          _serverTotal: s.total ?? 0,
          _serverItems: s.items || [],
          _serverNoSet: s.noSet === true,
        }));
        const namesForSeries = (prev.playerNames && prev.playerNames.length)
          ? prev.playerNames
          : scores.map(s => s.name || ("Player " + (s.id + 1)));
        const currentSeries = prev.currentSeries || {
          n: namesForSeries.length,
          players: namesForSeries.map((n, i) => ({ id: i, name: n, isAI: false, total: 0, wins: 0, consec: 0 })),
          round: 0, roomCode: prev.roomCode,
        };
        const updated = applySeriesFromServer(currentSeries, winner, gamePlayers, wildWin);
        const updatedWithRoom = { ...updated, roomCode: prev.roomCode };
        setRoundOverSeries(updatedWithRoom);
        return { ...prev, currentSeries: updatedWithRoom };
      });
    }

    return (
      <>
        <OnlineGameScreen
          socket={onlineData.socket}
          series={onlineData.currentSeries || { roomCode: onlineData.roomCode, players: (onlineData.playerNames || []).map((n, i) => ({ id: i, name: n, total: 0, wins: 0, consec: 0 })), round: 0 }}
          onEnd={() => setMode("home")}
          onRoundEnd={handleOnlineRoundEnd}
        />
      </>
    );
  }

  return null;
}
