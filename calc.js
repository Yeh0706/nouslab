// 星鐵傷害計算核心：所有百分比在這裡都用小數（16% = 0.16）
(function (root) {
  const L80 = 3767.5533;

  const ELEMENT_COEF = { physical: 2, fire: 2, wind: 1.5, ice: 1, lightning: 1, quantum: 0.5, imaginary: 0.5 };

  // ── 共用乘區 ──
  function defMult(p) {
    const a = 200 + 10 * p.atkLv;
    const shred = Math.min(1, p.defShred + p.defIgnore);
    const d = (200 + 10 * p.enemyLv) * (1 - shred);
    return a / (a + d);
  }
  const resMult = p => 1 - (p.res - p.resPen);
  const vulnMult = p => 1 + p.vuln;
  // 敵人特殊減傷（例如血腦屏障）對歡愉傷害可以另填；負數代表傷害提高
  const mitigMult = (p, elation) => (1 - p.mitig) * (1 - (elation ? p.specialElation : p.special));
  const toughMult = p => (p.broken ? 1 : 0.9);
  const toughCoef = p => 0.5 + p.toughness / 40;

  function critMults(p) {
    const cr = Math.min(1, Math.max(0, p.cr));
    return { non: 1, crit: 1 + p.cd, exp: 1 + cr * p.cd };
  }

  function commonZones(p, broken, elation) {
    return [
      ['防禦區', defMult(p)],
      ['抗性區', resMult(p)],
      ['受到的傷害提高（易傷區）', vulnMult(p)],
      ['受到的傷害降低（減傷區）', mitigMult(p, elation)],
      ['韌性區', broken === undefined ? toughMult(p) : broken],
      // 例：黃泉「奈落」造成的傷害為原傷害的 160%
      ['角色額外乘區', p.extraMult ?? 1],
    ];
  }

  // 每種傷害回傳 { base, zones, crit? }，base × Π zones × 暴擊 = 傷害
  const TYPES = {
    direct(p) {
      return {
        base: p.stat * p.mult,
        baseLabel: '屬性值 × 倍率',
        zones: [['傷害提高（增傷區）', 1 + p.dmgBoost], ...commonZones(p)],
        crit: critMults(p),
      };
    },
    dot(p) {
      return {
        base: p.stat * p.mult,
        baseLabel: '屬性值 × 倍率',
        zones: [['傷害提高（增傷區）', 1 + p.dmgBoost + p.dotBoost], ...commonZones(p)],
      };
    },
    break(p) {
      const coef = ELEMENT_COEF[p.element] ?? 1;
      return {
        base: p.levelCoef * coef * toughCoef(p),
        baseLabel: '等級係數 × 屬性係數 × 韌性係數',
        // 擊破那一下發生在擊破前，一律 0.9
        zones: [['擊破特攻', 1 + p.be], ['擊破傷害提高', 1 + p.breakBoost], ...commonZones(p, 0.9)],
      };
    },
    superBreak(p) {
      return {
        base: p.levelCoef * (p.toughRed / 10) * p.conv,
        baseLabel: '等級係數 × 削韌值/10 × 轉換倍率',
        zones: [['擊破特攻', 1 + p.be], ['超擊破／擊破傷害提高', 1 + p.superBoost + p.breakBoost], ...commonZones(p, 1)],
      };
    },
    breakDot(p) {
      const L = p.levelCoef;
      let base;
      switch (p.dotKind) {
        case 'burn': base = L; break;
        case 'shock': base = 2 * L; break;
        case 'wind': base = L * p.stacks; break;
        case 'bleed': base = Math.min(p.enemyHp * (p.enemyClass === 'elite' ? 0.07 : 0.16), 2 * L * toughCoef(p)); break;
        case 'entangle': base = 0.6 * L * p.stacks * toughCoef(p); break;
        default: base = L; // freeze
      }
      return {
        base,
        baseLabel: '擊破持續傷害基礎值',
        zones: [['擊破特攻', 1 + p.be], ['擊破傷害提高', 1 + p.breakBoost], ...commonZones(p)],
      };
    },
    elation(p) {
      const pl = Math.max(0, p.punchline);
      return {
        base: p.levelCoef * 2 * p.elationMult,
        baseLabel: '等級係數 × 2 × 歡愉倍率',
        zones: [
          ['歡愉度', 1 + p.elation],
          ['增笑', 1 + p.merry],
          ['笑點係數', 1 + (5 * pl) / (pl + 240)],
          ...commonZones(p, undefined, true),
        ],
        crit: critMults(p),
      };
    },
    // 記錄型：先記錄非真實傷害的 X%，結算時再換算成真實傷害；不乘任何乘區
    // 可分兩個來源記錄不同比例（例：賽飛兒對老主顧 12%、對其他敵人 8%）
    trueRecord(p) {
      return {
        base: p.sourceDmg * p.recordPct + (p.sourceOther || 0) * (p.recordPctOther || 0),
        baseLabel: '記錄值',
        zones: [['換算比例', p.convRatio]],
      };
    },
  };

  function compute(type, p) {
    const r = TYPES[type](p);
    const prod = r.zones.reduce((a, [, v]) => a * v, 1);
    const plain = r.base * prod;
    const out = {
      base: r.base,
      baseLabel: r.baseLabel,
      zones: r.zones,
      canCrit: !!r.crit,
      non: plain,
      crit: r.crit ? plain * r.crit.crit : plain,
      exp: r.crit ? plain * r.crit.exp : plain,
    };
    if (r.crit) out.critZone = r.crit;
    // 附加真實傷害：從打出的傷害換算，不再乘任何乘區
    if (type !== 'trueRecord' && p.trueRatio > 0) {
      out.trueDmg = { non: out.non * p.trueRatio, crit: out.crit * p.trueRatio, exp: out.exp * p.trueRatio };
    }
    return out;
  }

  // 該項目的總期望傷害（含附加真傷），提升比較用
  function expectedTotal(type, p) {
    const r = compute(type, p);
    return r.exp + (r.trueDmg ? r.trueDmg.exp : 0);
  }

  // ── 排軸：速度與行動值 ──
  const AV_UNIT = 10000;
  // 阿哈時刻速度：歡愉角色戰鬥中速度由快到慢，依序乘上係數（社群實測，非官方）
  const AHA_COEF = [0.2, 0.1, 0.05, 0.025];

  // 戰鬥中速度 = 面板速度 + 基礎速度 × 速度提高 %（加總）
  const battleSpeed = (panel, base, buffPct) => panel + base * buffPct;

  // base：沒有星神★阿哈時 80；有的話為星神★阿哈的基礎速度（含光錐的基礎速度提高）
  function ahaSpeed(base, elationSpeeds) {
    const sorted = [...elationSpeeds].sort((a, b) => b - a);
    const terms = sorted.slice(0, AHA_COEF.length).map((v, i) => [v, AHA_COEF[i]]);
    return { speed: terms.reduce((a, [v, c]) => a + v * c, base), terms };
  }

  // 排軸推演：依時間逐一處理每次行動，行動當下的終結技效果（拉條、額外回合）會改變之後的時間
  // units: [{ name, speed, adv, aha?, afterAha?, elation?, aeon?, eagle? }]
  //   adv：開局行動提前（小數，上限 100%）
  //   aha：阿哈時刻；afterAha：阿哈時刻結束時獲得 1 個額外回合（例：火花 2 星魂）
  //   eagle：施放終結技後自己行動提前 pct（預設晨昏交界的翔鷹 4 件 25%）。{ every, first } = 第 first 動起每 every 動開一次大
  //          （「動」含額外回合：額外回合也會回能量，充滿就在同一行動值開大）；
  //          { auto: true } = 跟著該角色自己的終結技時機（星神★阿哈、真珠）
  //          ahaExtra：施放終結技時使阿哈立即獲得 1 個額外回合（爻光終結技）
  // 第 1 次行動 = 10000 ÷ 速度 × (1 − 行動提前)，之後每次再加 10000 ÷ 速度
  // 行動提前 = 剩餘行動值減少 pct × 10000 ÷ 速度，最低降到當下；同一時間點依隊伍順序（阿哈時刻排最後）
  // opts.pulls: [{ key: '隊伍序號:第幾次行動', pct }]：在該次行動時施放星神★阿哈終結技，使阿哈時刻行動提前 pct
  // opts.firstPullBonus：第一次星神★阿哈終結技再加的行動提前（6 星魂 100%）
  // opts.opening：開場 0 行動值有阿哈時刻（星神★阿哈秘技），阿哈時刻結束時的額外回合（火花 2 星魂）也排在 0
  // 額外回合的 key 為「隊伍序號:e第幾次行動（含額外回合）」，可以在這一列插入星神★阿哈終結技
  // opts.pearl: { idx, target, pct, extra, e2, first }：真珠終結技
  //   first = 第一次施放的時機（'start' = 開場 0 行動值，或任一列的 key：一般行動、阿哈時刻、額外回合都可以，
  //           在那一列結束後施放）；之後每隔真珠 2 次行動施放一次
  //   效果：美學底本行動提前 pct；extra（4 名以上歡愉角色）時另外獲得 1 個額外回合；
  //         e2（2 星魂）時其他歡愉角色也行動提前 pct
  const EAGLE = 0.25;
  function timeline(units, maxAV, opts = {}) {
    const EPS = 1e-9;
    const st = units.map((u, idx) => {
      const gap = u.speed > 0 ? AV_UNIT / u.speed : Infinity;
      // n：一般行動次數；e：含額外回合的行動次數（算能量）
      return { u, idx, gap, next: gap * (1 - Math.min(1, Math.max(0, u.adv || 0))), n: 0, e: 0, pulled: false };
    });
    const acts = [];
    const pulls = opts.pulls || [];
    let pullCount = 0;
    const advance = (s, pct, t) => {
      if (!s || !isFinite(s.gap) || !(pct > 0)) return;
      s.next = Math.max(t, s.next - pct * s.gap); s.pulled = true;
    };
    // 每次行動（含額外回合）都回能量：依「X 動一大」開終結技（遺器自己提前、舞！舞！舞！我方全體提前），再放拉條戰技
    const turnEffects = (s, t, act) => {
      s.e++;
      const e = s.u.eagle;
      if (e && !e.auto && e.every >= 1 && s.e >= e.first && (s.e - e.first) % e.every === 0) {
        act.ult = true;
        advance(s, e.pct ?? EAGLE, t);
        if (e.allPct) st.forEach(x => { if (!x.u.aha) advance(x, e.allPct, t); });
        if (e.ahaExtra) ahaExtraTurn(t);
      }
      // 拉條戰技（角色自己的技能）：skill = { idx, pct }，每次行動指定 1 名隊友行動提前
      const sk = s.u.skill;
      if (sk && st[sk.idx] && sk.idx !== s.idx) { act.skill = true; advance(st[sk.idx], sk.pct, t); }
    };
    // kind：'aha' = 阿哈時刻結束時的額外回合（火花 2 星魂）、'pearl' = 真珠終結技給美學底本的額外回合
    // 額外回合也是一次行動：回能量、可開大、可放戰技，也能在這一列插入星神★阿哈終結技
    const extraRow = (s, t, kind) => {
      const act = { ...s.u, idx: s.idx, av: t, extra: true, exKind: kind, key: `${s.idx}:e${s.e + 1}` };
      acts.push(act);
      turnEffects(s, t, act);
      ahaPull(act.key, t, act);
      pearlAt(act.key, t, act);
    };

    const P = opts.pearl && st[opts.pearl.idx] ? { ...opts.pearl, fired: false, nextN: null } : null;
    const pearlUlt = t => {
      const ps = st[P.idx]; const tg = st[P.target];
      P.fired = true; P.nextN = ps.n + 2;
      if (tg) {
        advance(tg, P.pct, t);
        if (P.extra) extraRow(tg, t, 'pearl');
      }
      if (P.e2) st.forEach(s => { if (s.u.elation && s.idx !== P.idx && s.idx !== P.target) advance(s, P.pct, t); });
      if (ps.u.eagle) advance(ps, ps.u.eagle.pct ?? EAGLE, t);
    };
    // 真珠第一次終結技：選在哪一列，就在那一列結束後施放（阿哈時刻、額外回合中不能插入終結技）
    const pearlAt = (key, t, act) => {
      if (!P || P.fired || P.first !== key) return;
      act.pearlFirst = true;
      if (act.idx === P.idx && !act.extra) act.ult = true;
      pearlUlt(t);
    };

    // 星神★阿哈終結技（排軸上按下的時機）：一般角色的行動、阿哈時刻結束時（key 為阿哈時刻那一列），
    // 或開場 0 行動值的阿哈時刻（key 'start'）都可以；阿哈時刻行動提前，星神★阿哈有風套時自己也提前
    const ahaPull = (key, t, act) => {
      const pull = pulls.find(p => p.key === key);
      if (!pull) return;
      if (act) act.pull = true;
      const pct = pull.pct + (pullCount++ === 0 ? opts.firstPullBonus || 0 : 0);
      st.forEach(s => { if (s.u.aha) advance(s, pct, t); if (s.u.aeon && s.u.eagle) advance(s, s.u.eagle.pct ?? EAGLE, t); });
    };
    // 爻光終結技：阿哈立即獲得 1 個額外回合＝多一次阿哈時刻（不影響原本阿哈時刻的時間）；結束時一樣觸發火花 2 星魂
    const ahaExtraTurn = t => {
      const a = st.find(s => s.u.aha); if (!a) return;
      const act = { ...a.u, idx: a.idx, av: t, extra: true, exKind: 'yaoguang', key: `${a.idx}:e${++a.e}` };
      acts.push(act);
      pearlAt(act.key, t, act);
      st.forEach(s => { if (s.u.afterAha) extraRow(s, t, 'aha'); });
      ahaPull(act.key, t, act);
    };
    if (opts.opening) st.forEach(s => { if (s.u.afterAha) extraRow(s, 0, 'aha'); });
    if (P && P.first === 'start') pearlUlt(0);
    ahaPull('start', 0);

    for (let guard = 0; guard < 5000; guard++) {
      let cur = null;
      for (const s of st) {
        if (!isFinite(s.gap)) continue;
        if (!cur || s.next < cur.next - EPS || (Math.abs(s.next - cur.next) <= EPS && s.idx < cur.idx)) cur = s;
      }
      if (!cur || cur.next > maxAV + EPS) break;
      const t = cur.next; cur.n++;
      const key = `${cur.idx}:${cur.n}`;
      const act = { ...cur.u, idx: cur.idx, n: cur.n, av: t, key, pulled: cur.pulled };
      cur.pulled = false;
      acts.push(act);
      cur.next = t + cur.gap;
      if (cur.u.aha) {
        // 阿哈時刻結束時的額外回合；在阿哈時刻結束時開星神★阿哈終結技，會拉下一個阿哈時刻
        pearlAt(key, t, act);
        st.forEach(s => { if (s.u.afterAha) extraRow(s, t, 'aha'); });
        ahaPull(key, t, act);
        continue;
      }
      ahaPull(key, t, act);
      // 真珠終結技
      if (P) {
        let fire = false;
        if (!P.fired && P.first === key) pearlAt(key, t, act);
        else if (P.fired && cur.idx === P.idx && cur.n === P.nextN) { act.ult = true; pearlUlt(t); }
      }
      // 自己的終結技（X 動一大）與拉條戰技，排在真珠終結技之後
      turnEffects(cur, t, act);
    }
    return acts;
  }

  // ── 回能計算：x 動 1 大、能不能首動開大 ──
  // 一動＝角色這回合開始到下回合開始前。回合行動（普攻／強化普攻／戰技）每動固定 1 次，三選一；
  // 歡愉技、追加攻擊、憶靈技每動 n 次；終結技不算一動，回能算進下一輪起點
  // e：百分比都已換成小數。main：'auto'（有強化普攻＝單次回能大於 0 就打強化普攻，沒有就打戰技）或指定
  // extras 每項 { v, bind, fixed }：bind 是綁定的操作（見 EN_BIND_COUNT），fixed＝固定回能，不乘效率
  const EN_KILL = 10;
  const EN_TURN = ['skill', 'enhanced', 'basic'];
  function energy(e) {
    const err = 1 + e.errBonus;
    const mul = x => (x.fixed ? 1 : err);
    const main = EN_TURN.includes(e.main) ? e.main : e.acts.enhanced.e > 0 ? 'enhanced' : 'skill';
    // 每動各操作發生幾次
    const cnt = { basic: 0, enhanced: 0, skill: 0, [main]: 1, elation: e.acts.elation.n, followup: e.acts.followup.n, memo: e.acts.memo.n, turnStart: 1, turnAct: 1 };
    const exSum = pred => e.extras.filter(pred).reduce((s, x) => s + x.v * mul(x), 0);
    const actTurn = ['basic', 'enhanced', 'skill', 'elation', 'followup', 'memo'].reduce((s, k) => s + e.acts[k].e * cnt[k], 0) * err;
    const exTurn = e.extras.filter(x => x.bind in cnt).reduce((s, x) => s + x.v * cnt[x.bind] * mul(x), 0);
    const perTurn = actTurn + exTurn;
    const ultGain = e.acts.ult.e * err + exSum(x => x.bind === 'ult');
    // 秘技施放的戰技：戰技回能與綁定戰技的額外回能都算
    const tech = e.technique ? e.acts.skill.e * err + exSum(x => x.bind === 'skill') : 0;
    const startGain = exSum(x => x.bind === 'start');
    const hit = e.hit * err, kill = EN_KILL * err;
    const EPS = 1e-9;
    // 從 s 開始，每動 +perTurn，第幾動充滿（0＝起點已滿）
    const turns = s => (s >= e.max - EPS ? 0 : perTurn > 0 ? Math.ceil((e.max - s - EPS) / perTurn) : Infinity);
    // 少一動（或首動）時還差多少，要受擊、擊殺幾次補；每動最多受擊 1 次算合理
    const gap = (s, k) => {
      if (!(k >= 2) || !isFinite(k)) return null;
      const d = e.max - s - (k - 1) * perTurn;
      const hits = Math.ceil(d / hit - EPS);
      return { k: k - 1, need: d, hits, kills: Math.ceil(d / kill - EPS), ok: hits <= k - 1 };
    };
    const bars = (s, k) => {
      const out = [s];
      for (let i = 1; i <= Math.min(k, 30); i++) out.push(s + i * perTurn);
      return out.map(v => Math.min(v, e.max));
    };
    const s0 = Math.min(e.max, e.max * e.initPct + startGain + tech);
    const k1 = turns(s0);
    const sC = Math.min(e.max, ultGain);
    const k = turns(sC);
    // 穩定循環：每 hitEvery 動受擊 1 次（hitEvery 為 0 時不算）
    const hitPer = e.hitEvery > 0 ? hit / e.hitEvery : 0;
    const steadyTurn = perTurn + hitPer;
    const kS = sC >= e.max - EPS ? 0 : steadyTurn > 0 ? Math.ceil((e.max - sC - EPS) / steadyTurn) : Infinity;
    return {
      err, main, cnt, perTurn, actTurn, exTurn, ultGain, startGain, tech, hit, kill,
      first: { s: s0, k: k1, gap: gap(s0, k1), bars: bars(s0, k1) },
      cycle: { s: sC, k, gap: gap(sC, k), bars: bars(sC, k) },
      steady: { k: kS, perTurn: steadyTurn, hitPer },
    };
  }

  // ── 速度閾值：在 T 行動值內行動 n 次需要的速度 ──
  // 需要的速度 = (n − 開局行動提前 − 開大行動提前 × 第 n 動之前施放的終結技次數 − 隊友拉條合計) × 10000 ÷ T
  // o.first：第幾動之後施放第 1 次終結技（0＝0 行動值開大、1＝首動開大、2＝二動開大）；o.every：之後每幾動 1 大
  // o.ultAdv：施放終結技後自己行動提前（風套 0.25、舞舞舞 0.24）
  // 逐欄：o.ts[j] 行動值、o.startAdv[j] 開局行動提前（混沌第 2 波不算）、o.pulls[j] 隊友拉條合計（拉條 × 次數）
  function speedThreshold(o) {
    const isUlt = n => n >= Math.max(1, o.first) && o.every > 0 && (n - o.first) % o.every === 0;
    // 第 n 動之前（第 0～n−1 動之後）施放了幾次終結技，每次讓下一動提前
    const ultsBefore = n => (n - 1 >= o.first && o.every > 0 ? Math.floor((n - 1 - o.first) / o.every) + 1 : 0);
    const rows = [];
    for (let n = 1; n <= o.rows; n++) {
      const base = n - (o.ultAdv || 0) * ultsBefore(n);
      rows.push({ n, ult: isUlt(n), need: o.ts.map((T, j) => Math.max(0, (base - (o.startAdv?.[j] || 0) - (o.pulls?.[j] || 0)) * AV_UNIT / T)) });
    }
    return rows;
  }

  root.HSR = { L80, ELEMENT_COEF, TYPES, compute, expectedTotal, defMult, AV_UNIT, AHA_COEF, battleSpeed, ahaSpeed, timeline, energy, speedThreshold };
  if (typeof module !== 'undefined') module.exports = root.HSR;
})(typeof window !== 'undefined' ? window : globalThis);
