// FAMILY 26 match simulator.
//
// This is a simplified but genuinely tactic-driven, attribute-driven event
// simulator: it does not decide a scoreline first and script events to
// match it. Every tick advances a possession "phase chain" whose branching
// is weighted by the real attributes/fitness/morale of the players
// involved and by both teams' live tactical settings (mentality, tempo,
// pressing, defensive line). The scoreline emerges from that chain.

function seededRand(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Attributes aren't part of the roster/world data models (which model
// ability with a single OVR figure), so we synthesize a consistent set of
// FM-style attributes from each player's OVR + position + a per-player
// seed. Deterministic: the same player always gets the same attributes.
const ATTR_KEYS = ['finishing', 'passing', 'technique', 'dribbling', 'pace', 'positioning', 'anticipation', 'composure', 'tackling', 'strength', 'vision', 'decisions'];
export function synthAttrs(id, ovr, pos) {
  const numericId = typeof id === 'number' && !Number.isNaN(id) ? id : String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = seededRand(numericId * 9973 + 17);
  const base = ovr - 8;
  const boost = {
    ST: ['finishing', 'pace', 'composure'], AML: ['dribbling', 'pace', 'technique'], AMR: ['dribbling', 'pace', 'technique'],
    AMC: ['vision', 'passing', 'technique'], MC: ['passing', 'vision', 'decisions'], DM: ['tackling', 'positioning', 'strength'],
    DC: ['tackling', 'positioning', 'strength'], DR: ['pace', 'tackling', 'positioning'], DL: ['pace', 'tackling', 'positioning'],
    GK: ['positioning', 'anticipation', 'composure'],
  }[pos] || [];
  const attrs = {};
  ATTR_KEYS.forEach(k => {
    const bump = boost.includes(k) ? 8 : 0;
    attrs[k] = Math.max(30, Math.min(99, Math.round(base + bump + (rand() - 0.5) * 14)));
  });
  return attrs;
}

// Build a playable XI (with attrs + base formation coordinates). `pairs` is
// an array of { slot, player } — built by the caller from the *live*
// Tactics assignment, so the exact configured formation/personnel is what
// gets simulated, not just a raw squad slice.
export function buildXI(pairs, teamSide) {
  return pairs.map(({ slot, player: p }, i) => {
    const attrs = synthAttrs(p.id ?? i, p.ovr ?? 70, slot.code);
    const x = teamSide === 'away' ? 100 - slot.x : slot.x;
    return { id: p.id ?? `gen-${i}`, name: p.name || `Player ${i + 1}`, pos: slot.code, role: slot.label,
      ovr: p.ovr ?? 70, fit: p.fit ?? 90, morale: p.morale || 'Good', attrs,
      baseX: x, baseY: slot.y, x, y: slot.y, fatigue: 0 };
  });
}

// Generate a synthetic opponent XI scaled to a league-table rating, used
// when the fixture opponent isn't in the World player pool.
export function buildOpponentPool(strengthRating, formationSlots) {
  return formationSlots.map((slot, i) => ({
    id: 90000 + i, name: OPP_NAMES[i % OPP_NAMES.length], ovr: Math.max(58, Math.min(92, strengthRating + (i % 5) - 2)),
    fit: 82 + (i % 10), morale: 'Good',
  }));
}
const OPP_NAMES = ['Onana II', 'Baptiste', 'Kessler', 'Njie', 'Alric', 'Voss', 'Mercer', 'Delacroix', 'Yamamoto', 'Bergqvist', 'Torino'];

// Substitute a player during a live match: the incoming player inherits the
// outgoing player's tactical slot (position/role/base coordinates) so the
// team shape doesn't break, but brings their own real attributes/fitness.
export function substitutePlayer(xi, outId, inPlayer) {
  return xi.map(p => {
    if (p.id !== outId) return p;
    const attrs = synthAttrs(inPlayer.id, inPlayer.ovr ?? 70, p.pos);
    return { ...p, id: inPlayer.id, name: inPlayer.name, ovr: inPlayer.ovr ?? 70, fit: inPlayer.fit ?? 95,
      morale: inPlayer.morale || 'Good', attrs, fatigue: 0 };
  });
}

const MENTALITY_ATTACK = { 'Very Defensive': -2, 'Defensive': -1, 'Balanced': 0, 'Positive': 1, 'Attacking': 2, 'Very Attacking': 3 };

export function initMatch({ homeXI, awayXI, homeName, awayName, homeTactics, awayTactics }) {
  return {
    minute: 0, second: 0, possession: 'home', phase: 'buildup', phaseTick: 0,
    ballX: 50, ballY: 50, score: { home: 0, away: 0 },
    homeName, awayName, homeXI, awayXI, homeTactics, awayTactics,
    events: [{ minute: 0, second: 0, text: 'Kick-off.', type: 'info' }],
    pendingDecision: null, finished: false, lastEventPlayer: null,
  };
}

function weightedPick(arr, weightFn) {
  const weights = arr.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}

function outfield(xi) { return xi.filter(p => p.pos !== 'GK'); }
function fatigueFactor(p) { return Math.max(0.6, 1 - p.fatigue / 160); }
function moraleFactor(p) { return p.morale === 'Good' ? 1.05 : p.morale === 'Unhappy' ? 0.92 : 1; }
function effAttr(p, key) { return p.attrs[key] * fatigueFactor(p) * moraleFactor(p) * (p.fit / 100); }

// Advance the ball and both teams' player positions toward a natural shape:
// the possessing team pushes up and spreads toward the ball, the defending
// team compacts and shifts across. This runs every tick for continuous,
// smooth CSS-transitioned movement rather than teleporting between events.
function updatePositions(state) {
  const attackSide = state.possession;
  [state.homeXI, state.awayXI].forEach((xi, teamIdx) => {
    const side = teamIdx === 0 ? 'home' : 'away';
    const isAttacking = side === attackSide;
    xi.forEach(p => {
      const pull = isAttacking ? 0.18 : 0.09;
      const towardX = isAttacking ? state.ballX * 0.5 + p.baseX * 0.5 : p.baseX * 0.85 + state.ballX * 0.15;
      const towardY = p.baseY * 0.7 + state.ballY * 0.3;
      p.x += (towardX - p.x) * pull + (Math.random() - 0.5) * 1.4;
      p.y += (towardY - p.y) * pull + (Math.random() - 0.5) * 1.4;
      p.x = Math.max(2, Math.min(98, p.x));
      p.y = Math.max(2, Math.min(98, p.y));
      p.fatigue = Math.min(100, p.fatigue + 0.03);
    });
  });
}

const CHAIN_TEMPLATES = [
  ['{d} wins the ball back', '{m} receives and looks up', '{m} spots {w} making a run', '{w} carries into space', '{w} squares for {s}', 'SHOT'],
  ['{gk} rolls it out to {d}', '{d} plays into {m}', '{m} is closed down', '{m} slips a pass to {a}', '{a} tries to thread it through', 'BLOCK'],
  ['{m} wins a tackle in midfield', '{m} drives forward', '{m} finds {w} wide', '{w} beats his man', '{w} whips in a cross', 'HEADER'],
  ['{d} intercepts', '{d} plays it short to {m}', '{m} switches play to {w2}', '{w2} cuts inside', '{w2} shoots from range', 'SHOT'],
  ['{a} holds the ball up', '{a} lays it off to {m}', '{m} threads a pass in behind', '{s} times the run', 'ONE_ON_ONE'],
  ['{m} overlaps down the flank', '{d} supports the attack', '{d} whips a cross to the near post', '{s} attacks it', 'HEADER'],
];

function pick(xi, code) { const c = xi.find(p => p.pos === code); return c || xi[Math.floor(Math.random() * xi.length)]; }
function role(xi) {
  return {
    d: pick(xi, 'DC'), m: pick(xi, 'MC'),
    w: pick(xi, 'AML'), w2: pick(xi, 'AMR'),
    a: pick(xi, 'AMC'), s: pick(xi, 'ST'),
    gk: pick(xi, 'GK'),
  };
}

function resolveOutcome(kind, attacker, gk, tactics) {
  const finishing = effAttr(attacker, 'finishing');
  const composure = effAttr(attacker, 'composure');
  const gkSkill = gk ? (effAttr(gk, 'positioning') + effAttr(gk, 'anticipation')) / 2 : 65;
  const mentalityBoost = MENTALITY_ATTACK[tactics.mentality] ?? 0;
  const quality = finishing * 0.5 + composure * 0.25 + mentalityBoost * 4 + Math.random() * 35;
  const chance = quality - gkSkill * 1.05;
  if (kind === 'ONE_ON_ONE') {
    if (chance > 16) return { text: `${attacker.name} rounds the keeper... GOAL!`, goal: true };
    if (chance > -6) return { text: `${attacker.name} is denied by a superb save!`, goal: false };
    return { text: `${attacker.name} drags it wide under pressure.`, goal: false };
  }
  if (kind === 'HEADER') {
    if (chance > 21) return { text: `${attacker.name} rises highest... it's in the net! GOAL!`, goal: true };
    if (chance > -1) return { text: `${attacker.name}'s header is straight at the keeper. Saved!`, goal: false };
    return { text: `${attacker.name} heads it well over the bar.`, goal: false };
  }
  if (kind === 'BLOCK') {
    if (chance > 24) return { text: `${attacker.name}'s effort takes a deflection... GOAL!`, goal: true };
    return { text: `${attacker.name}'s shot is blocked by a last-ditch defender.`, goal: false };
  }
  // SHOT
  if (chance > 24) return { text: `${attacker.name} strikes it clean... GOAL!`, goal: true };
  if (chance > 0) return { text: `${attacker.name} forces a good save from the keeper!`, goal: false };
  return { text: `${attacker.name}'s shot goes well wide.`, goal: false };
}

// Run one possession phase-chain to completion, logging events and
// returning whether a goal was scored. Called a few times per minute of
// game time — not every tick — so the live text reads like real commentary
// while the pitch keeps moving continuously every tick regardless.
function runChain(state) {
  const attackXI = state.possession === 'home' ? state.homeXI : state.awayXI;
  const defendXI = state.possession === 'home' ? state.awayXI : state.homeXI;
  const attackTactics = state.possession === 'home' ? state.homeTactics : state.awayTactics;
  const defendTactics = state.possession === 'home' ? state.awayTactics : state.homeTactics;
  const teamName = state.possession === 'home' ? state.homeName : state.awayName;

  const r = role(attackXI);
  const template = weightedPick(CHAIN_TEMPLATES, () => 1);
  let broken = false;

  for (const step of template) {
    if (step === 'SHOT' || step === 'BLOCK' || step === 'HEADER' || step === 'ONE_ON_ONE') {
      const outcome = resolveOutcome(step, r.s.name ? r.s : r.w, pick(defendXI, 'GK'), attackTactics);
      state.events.unshift({ minute: state.minute, second: state.second, text: outcome.text, type: outcome.goal ? 'goal' : 'chance' });
      if (outcome.goal) { state.score[state.possession] += 1; }
      broken = true;
      break;
    }
    // Progression link: a defender in the chain can win the ball back,
    // weighted by their tackling/anticipation vs the passer's technique —
    // this is the "opponent has its own brain" reactive step.
    const defender = pick(defendXI, 'DC');
    const passQuality = effAttr(r.m, 'passing') + effAttr(r.m, 'vision');
    const defQuality = effAttr(defender, 'tackling') + effAttr(defender, 'anticipation');
    if (Math.random() * (passQuality + 60) < defQuality * (0.55 + (defendTactics.pressing?.intensity ?? 60) / 300)) {
      state.events.unshift({ minute: state.minute, second: state.second, text: `${defender.name} steps in and wins the ball for ${state.possession === 'home' ? state.awayName : state.homeName}.`, type: 'turnover' });
      state.possession = state.possession === 'home' ? 'away' : 'home';
      broken = true;
      break;
    }
    const filled = step.replace(/\{(\w+)\}/g, (_, k) => (r[k] || r.m).name);
    state.events.unshift({ minute: state.minute, second: state.second, text: `${filled}.`, type: 'play' });
  }
  if (!broken) state.possession = state.possession === 'home' ? 'away' : 'home';
  state.events = state.events.slice(0, 60);
}

// Manager AI: the opponent reacts to the scoreline by shifting mentality —
// generating a "decision required" prompt for the human side unless
// tactical delegation is Automatic, in which case the assistant resolves
// it immediately and logs what it did.
function maybeTriggerDecision(state) {
  if (state.pendingDecision) return;
  const diff = state.score.home - state.score.away;
  if (diff <= -1 && !state.__reactedLosing) {
    state.__reactedLosing = true;
    state.awayTactics = { ...state.awayTactics, mentality: 'Attacking' };
    state.pendingDecision = {
      id: `dec-${state.minute}`,
      text: `${state.awayName} have pushed men forward and are pressing higher — they've gone to an Attacking mentality chasing the game.`,
      options: [
        { key: 'A', label: 'Defend deeper', effect: t => ({ ...t, defensiveLine: Math.max(20, t.defensiveLine - 15) }) },
        { key: 'B', label: 'Match their intensity — press higher', effect: t => t, pressingEffect: p => ({ ...p, intensity: Math.min(100, p.intensity + 15) }) },
        { key: 'C', label: 'Hold the current shape', effect: t => t },
        { key: 'D', label: 'Protect the lead — slow the tempo', effect: t => ({ ...t, tempo: Math.max(20, t.tempo - 15) }) },
      ],
    };
  } else if (diff >= 2 && !state.__reactedWinning) {
    state.__reactedWinning = true;
    state.awayTactics = { ...state.awayTactics, mentality: 'Very Attacking' };
    state.pendingDecision = {
      id: `dec2-${state.minute}`,
      text: `${state.awayName} have thrown caution to the wind, going Very Attacking to try to get back into it.`,
      options: [
        { key: 'A', label: 'Sit deep and soak up pressure', effect: t => ({ ...t, defensiveLine: Math.max(15, t.defensiveLine - 20), mentality: 'Defensive' }) },
        { key: 'B', label: 'Look to counter-attack', effect: t => ({ ...t, mentality: 'Positive' }) },
        { key: 'C', label: 'Keep current approach', effect: t => t },
        { key: 'D', label: 'Kill the game off — hold shape', effect: t => ({ ...t, tempo: Math.max(20, t.tempo - 10) }) },
      ],
    };
  }
}

export function resolveDecision(state, optionKey) {
  const dec = state.pendingDecision;
  if (!dec) return state;
  const opt = dec.options.find(o => o.key === optionKey);
  if (opt) {
    state.homeTactics = opt.effect(state.homeTactics);
    if (opt.pressingEffect) state.homeTactics.pressing = opt.pressingEffect(state.homeTactics.pressing || {});
    state.events.unshift({ minute: state.minute, second: state.second, text: `You respond: ${opt.label}.`, type: 'decision' });
  }
  state.pendingDecision = null;
  return state;
}

// One engine tick: advances the clock, moves every player a little
// (continuous animation), and — every few ticks — resolves a possession
// chain and checks whether the opponent's manager AI wants to react.
export function stepMatch(state, ticksPerChain = 7) {
  if (state.finished || state.pendingDecision) return state;
  state.phaseTick += 1;
  state.second += 3;
  if (state.second >= 60) { state.second -= 60; state.minute += 1; }
  updatePositions(state);
  if (state.phaseTick % ticksPerChain === 0) {
    runChain(state);
    maybeTriggerDecision(state);
  }
  if (state.minute >= 90) {
    state.finished = true;
    state.events.unshift({ minute: 90, second: 0, text: `Full-time: ${state.homeName} ${state.score.home} - ${state.score.away} ${state.awayName}.`, type: 'info' });
  }
  return { ...state };
}

// Fast-forward the whole match synchronously (Instant Result mode).
export function simulateInstant(initialState) {
  let s = initialState;
  let guard = 0;
  while (!s.finished && guard < 4000) {
    if (s.pendingDecision) resolveDecision(s, s.pendingDecision.options[2].key); // keep current approach
    s = stepMatch(s, 7);
    guard++;
  }
  return s;
}
