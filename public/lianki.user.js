// ==UserScript==
// @name        Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_info
// @version     2.21.3
// @author      lianki.com
// @description Lianki spaced repetition — offline-first with IndexedDB sync. Press , or . (or media keys) to control video speed with difficulty markers.
// @run-at      document-end
// @downloadURL https://www.lianki.com/lianki.user.js
// @updateURL   https://www.lianki.com/lianki.meta.js
// @connect     lianki.com
// @connect     www.lianki.com
// @connect     beta.lianki.com
// ==/UserScript==

if (window.self !== window.top) return;
globalThis.unload_Lianki?.();
globalThis.unload_Lianki = main();

// ============================================================================
// Bundled Dependencies (ts-fsrs + idb-keyval) — 21KB
// ============================================================================
(() => {
  var { defineProperty: j, getOwnPropertyNames: i, getOwnPropertyDescriptor: r } = Object,
    s = Object.prototype.hasOwnProperty;
  var k = new WeakMap(),
    e = (J) => {
      var K = k.get(J),
        Q;
      if (K) return K;
      if (
        ((K = j({}, "__esModule", { value: !0 })),
        (J && typeof J === "object") || typeof J === "function")
      )
        i(J).map(
          (X) =>
            !s.call(K, X) &&
            j(K, X, { get: () => J[X], enumerable: !(Q = r(J, X)) || Q.enumerable }),
        );
      return (k.set(J, K), K);
    };
  var t = (J, K) => {
    for (var Q in K)
      j(J, Q, { get: K[Q], enumerable: !0, configurable: !0, set: (X) => (K[Q] = () => X) });
  };
  var Y0 = {};
  t(Y0, {
    set: () => l,
    keys: () => o,
    get: () => d,
    generatorParameters: () => F,
    fsrs: () => h,
    del: () => u,
    createStore: () => b,
    clear: () => a,
    Rating: () => T,
  });
  var L = ((J) => (
      (J[(J.New = 0)] = "New"),
      (J[(J.Learning = 1)] = "Learning"),
      (J[(J.Review = 2)] = "Review"),
      (J[(J.Relearning = 3)] = "Relearning"),
      J
    ))(L || {}),
    T = ((J) => (
      (J[(J.Manual = 0)] = "Manual"),
      (J[(J.Again = 1)] = "Again"),
      (J[(J.Hard = 2)] = "Hard"),
      (J[(J.Good = 3)] = "Good"),
      (J[(J.Easy = 4)] = "Easy"),
      J
    ))(T || {});
  class E {
    static card(J) {
      return {
        ...J,
        state: E.state(J.state),
        due: E.time(J.due),
        last_review: J.last_review ? E.time(J.last_review) : void 0,
      };
    }
    static rating(J) {
      if (typeof J == "string") {
        let K = J.charAt(0).toUpperCase(),
          Q = J.slice(1).toLowerCase(),
          X = T[`${K}${Q}`];
        if (X === void 0) throw Error(`Invalid rating:[${J}]`);
        return X;
      } else if (typeof J == "number") return J;
      throw Error(`Invalid rating:[${J}]`);
    }
    static state(J) {
      if (typeof J == "string") {
        let K = J.charAt(0).toUpperCase(),
          Q = J.slice(1).toLowerCase(),
          X = L[`${K}${Q}`];
        if (X === void 0) throw Error(`Invalid state:[${J}]`);
        return X;
      } else if (typeof J == "number") return J;
      throw Error(`Invalid state:[${J}]`);
    }
    static time(J) {
      if (typeof J == "object" && J instanceof Date) return J;
      if (typeof J == "string") {
        let K = Date.parse(J);
        if (isNaN(K)) throw Error(`Invalid date:[${J}]`);
        return new Date(K);
      } else if (typeof J == "number") return new Date(J);
      throw Error(`Invalid date:[${J}]`);
    }
    static review_log(J) {
      return {
        ...J,
        due: E.time(J.due),
        rating: E.rating(J.rating),
        state: E.state(J.state),
        review: E.time(J.review),
      };
    }
  }
  var J0 = "4.7.1";
  ((Date.prototype.scheduler = function (J, K) {
    return K0(this, J, K);
  }),
    (Date.prototype.diff = function (J, K) {
      return Q0(this, J, K);
    }),
    (Date.prototype.format = function () {
      return X0(this);
    }),
    (Date.prototype.dueFormat = function (J, K, Q) {
      return Z0(this, J, K, Q);
    }));
  function K0(J, K, Q) {
    return new Date(
      Q ? E.time(J).getTime() + K * 24 * 60 * 60 * 1000 : E.time(J).getTime() + K * 60 * 1000,
    );
  }
  function Q0(J, K, Q) {
    if (!J || !K) throw Error("Invalid date");
    let X = E.time(J).getTime() - E.time(K).getTime(),
      Z = 0;
    switch (Q) {
      case "days":
        Z = Math.floor(X / 86400000);
        break;
      case "minutes":
        Z = Math.floor(X / 60000);
        break;
    }
    return Z;
  }
  function X0(J) {
    let K = E.time(J),
      Q = K.getFullYear(),
      X = K.getMonth() + 1,
      Z = K.getDate(),
      I = K.getHours(),
      O = K.getMinutes(),
      z = K.getSeconds();
    return `${Q}-${w(X)}-${w(Z)} ${w(I)}:${w(O)}:${w(z)}`;
  }
  function w(J) {
    return J < 10 ? `0${J}` : `${J}`;
  }
  var x = [60, 60, 24, 31, 12],
    M = ["second", "min", "hour", "day", "month", "year"];
  function Z0(J, K, Q, X = M) {
    ((J = E.time(J)), (K = E.time(K)), X.length !== M.length && (X = M));
    let Z = J.getTime() - K.getTime(),
      I;
    for (Z /= 1000, I = 0; I < x.length && !(Z < x[I]); I++) Z /= x[I];
    return `${Math.floor(Z)}${Q ? X[I] : ""}`;
  }
  var I0 = Object.freeze([T.Again, T.Hard, T.Good, T.Easy]),
    O0 = [
      { start: 2.5, end: 7, factor: 0.15 },
      { start: 7, end: 20, factor: 0.1 },
      { start: 20, end: 1 / 0, factor: 0.05 },
    ];
  function T0(J, K, Q) {
    let X = 1;
    for (let O of O0) X += O.factor * Math.max(Math.min(J, O.end) - O.start, 0);
    J = Math.min(J, Q);
    let Z = Math.max(2, Math.round(J - X)),
      I = Math.min(Math.round(J + X), Q);
    return (J > K && (Z = Math.max(Z, K + 1)), (Z = Math.min(Z, I)), { min_ivl: Z, max_ivl: I });
  }
  function V(J, K, Q) {
    return Math.min(Math.max(J, K), Q);
  }
  function z0(J, K) {
    let Q = Date.UTC(J.getUTCFullYear(), J.getUTCMonth(), J.getUTCDate()),
      X = Date.UTC(K.getUTCFullYear(), K.getUTCMonth(), K.getUTCDate());
    return Math.floor((X - Q) / 86400000);
  }
  var E0 = 0.9,
    H0 = 36500,
    L0 = Object.freeze([
      0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
      1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
    ]),
    P0 = !1,
    U0 = !0,
    B0 = `v${J0} using FSRS-5.0`,
    U = 0.01,
    C = 100,
    q = Object.freeze([
      Object.freeze([U, C]),
      Object.freeze([U, C]),
      Object.freeze([U, C]),
      Object.freeze([U, C]),
      Object.freeze([1, 10]),
      Object.freeze([0.001, 4]),
      Object.freeze([0.001, 4]),
      Object.freeze([0.001, 0.75]),
      Object.freeze([0, 4.5]),
      Object.freeze([0, 0.8]),
      Object.freeze([0.001, 3.5]),
      Object.freeze([0.001, 5]),
      Object.freeze([0.001, 0.25]),
      Object.freeze([0.001, 0.9]),
      Object.freeze([0, 4]),
      Object.freeze([0, 1]),
      Object.freeze([1, 6]),
      Object.freeze([0, 2]),
      Object.freeze([0, 2]),
    ]),
    F = (J) => {
      let K = [...L0];
      return (
        J?.w &&
          (J.w.length === 19
            ? (K = [...J.w])
            : J.w.length === 17 &&
              ((K = J?.w.concat([0, 0])),
              (K[4] = +(K[5] * 2 + K[4]).toFixed(8)),
              (K[5] = +(Math.log(K[5] * 3 + 1) / 3).toFixed(8)),
              (K[6] = +(K[6] + 0.5).toFixed(8)),
              console.debug("[FSRS V5]auto fill w to 19 length"))),
        (K = K.map((Q, X) => V(Q, q[X][0], q[X][1]))),
        {
          request_retention: J?.request_retention || E0,
          maximum_interval: J?.maximum_interval || H0,
          w: K,
          enable_fuzz: J?.enable_fuzz ?? P0,
          enable_short_term: J?.enable_short_term ?? U0,
        }
      );
    };
  function N(J, K) {
    let Q = {
      due: J ? E.time(J) : new Date(),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: L.New,
      last_review: void 0,
    };
    return K && typeof K == "function" ? K(Q) : Q;
  }
  class p {
    c;
    s0;
    s1;
    s2;
    constructor(J) {
      let K = $0();
      ((this.c = 1),
        (this.s0 = K(" ")),
        (this.s1 = K(" ")),
        (this.s2 = K(" ")),
        J == null && (J = +new Date()),
        (this.s0 -= K(J)),
        this.s0 < 0 && (this.s0 += 1),
        (this.s1 -= K(J)),
        this.s1 < 0 && (this.s1 += 1),
        (this.s2 -= K(J)),
        this.s2 < 0 && (this.s2 += 1));
    }
    next() {
      let J = 2091639 * this.s0 + this.c * 0.00000000023283064365386963;
      return ((this.s0 = this.s1), (this.s1 = this.s2), (this.s2 = J - (this.c = J | 0)), this.s2);
    }
    set state(J) {
      ((this.c = J.c), (this.s0 = J.s0), (this.s1 = J.s1), (this.s2 = J.s2));
    }
    get state() {
      return { c: this.c, s0: this.s0, s1: this.s1, s2: this.s2 };
    }
  }
  function $0() {
    let J = 4022871197;
    return function (K) {
      K = String(K);
      for (let Q = 0; Q < K.length; Q++) {
        J += K.charCodeAt(Q);
        let X = 0.02519603282416938 * J;
        ((J = X >>> 0), (X -= J), (X *= J), (J = X >>> 0), (X -= J), (J += X * 4294967296));
      }
      return (J >>> 0) * 0.00000000023283064365386963;
    };
  }
  function D0(J) {
    let K = new p(J),
      Q = () => K.next();
    return (
      (Q.int32 = () => (K.next() * 4294967296) | 0),
      (Q.double = () => Q() + ((Q() * 2097152) | 0) * 0.00000000000000011102230246251565),
      (Q.state = () => K.state),
      (Q.importState = (X) => ((K.state = X), Q)),
      Q
    );
  }
  var S = -0.5,
    f = 0.2345679012345679;
  function V0(J, K) {
    return +Math.pow(1 + (f * J) / K, S).toFixed(8);
  }
  class y {
    param;
    intervalModifier;
    _seed;
    constructor(J) {
      ((this.param = new Proxy(F(J), this.params_handler_proxy())),
        (this.intervalModifier = this.calculate_interval_modifier(this.param.request_retention)));
    }
    get interval_modifier() {
      return this.intervalModifier;
    }
    set seed(J) {
      this._seed = J;
    }
    calculate_interval_modifier(J) {
      if (J <= 0 || J > 1) throw Error("Requested retention rate should be in the range (0,1]");
      return +((Math.pow(J, 1 / S) - 1) / f).toFixed(8);
    }
    get parameters() {
      return this.param;
    }
    set parameters(J) {
      this.update_parameters(J);
    }
    params_handler_proxy() {
      let J = this;
      return {
        set: function (K, Q, X) {
          return (
            Q === "request_retention" &&
              Number.isFinite(X) &&
              (J.intervalModifier = J.calculate_interval_modifier(Number(X))),
            Reflect.set(K, Q, X),
            !0
          );
        },
      };
    }
    update_parameters(J) {
      let K = F(J);
      for (let Q in K)
        if (Q in this.param) {
          let X = Q;
          this.param[X] = K[X];
        }
    }
    init_stability(J) {
      return Math.max(this.param.w[J - 1], 0.1);
    }
    init_difficulty(J) {
      return this.constrain_difficulty(this.param.w[4] - Math.exp((J - 1) * this.param.w[5]) + 1);
    }
    apply_fuzz(J, K) {
      if (!this.param.enable_fuzz || J < 2.5) return Math.round(J);
      let Q = D0(this._seed)(),
        { min_ivl: X, max_ivl: Z } = T0(J, K, this.param.maximum_interval);
      return Math.floor(Q * (Z - X + 1) + X);
    }
    next_interval(J, K) {
      let Q = Math.min(
        Math.max(1, Math.round(J * this.intervalModifier)),
        this.param.maximum_interval,
      );
      return this.apply_fuzz(Q, K);
    }
    linear_damping(J, K) {
      return +((J * (10 - K)) / 9).toFixed(8);
    }
    next_difficulty(J, K) {
      let Q = -this.param.w[6] * (K - 3),
        X = J + this.linear_damping(Q, J);
      return this.constrain_difficulty(this.mean_reversion(this.init_difficulty(T.Easy), X));
    }
    constrain_difficulty(J) {
      return Math.min(Math.max(+J.toFixed(8), 1), 10);
    }
    mean_reversion(J, K) {
      return +(this.param.w[7] * J + (1 - this.param.w[7]) * K).toFixed(8);
    }
    next_recall_stability(J, K, Q, X) {
      let Z = T.Hard === X ? this.param.w[15] : 1,
        I = T.Easy === X ? this.param.w[16] : 1;
      return +V(
        K *
          (1 +
            Math.exp(this.param.w[8]) *
              (11 - J) *
              Math.pow(K, -this.param.w[9]) *
              (Math.exp((1 - Q) * this.param.w[10]) - 1) *
              Z *
              I),
        U,
        36500,
      ).toFixed(8);
    }
    next_forget_stability(J, K, Q) {
      return +V(
        this.param.w[11] *
          Math.pow(J, -this.param.w[12]) *
          (Math.pow(K + 1, this.param.w[13]) - 1) *
          Math.exp((1 - Q) * this.param.w[14]),
        U,
        36500,
      ).toFixed(8);
    }
    next_short_term_stability(J, K) {
      return +V(J * Math.exp(this.param.w[17] * (K - 3 + this.param.w[18])), U, 36500).toFixed(8);
    }
    forgetting_curve = V0;
    next_state(J, K, Q) {
      let { difficulty: X, stability: Z } = J ?? { difficulty: 0, stability: 0 };
      if (K < 0) throw Error(`Invalid delta_t "${K}"`);
      if (Q < 0 || Q > 4) throw Error(`Invalid grade "${Q}"`);
      if (X === 0 && Z === 0)
        return { difficulty: this.init_difficulty(Q), stability: this.init_stability(Q) };
      if (Q === 0) return { difficulty: X, stability: Z };
      if (X < 1 || Z < U) throw Error(`Invalid memory state { difficulty: ${X}, stability: ${Z} }`);
      let I = this.forgetting_curve(K, Z),
        O = this.next_recall_stability(X, Z, I, Q),
        z = this.next_forget_stability(X, Z, I),
        H = this.next_short_term_stability(Z, Q),
        P = O;
      if (Q === 1) {
        let [$, Y] = [0, 0];
        this.param.enable_short_term && (($ = this.param.w[17]), (Y = this.param.w[18]));
        let D = Z / Math.exp($ * Y);
        P = V(+D.toFixed(8), U, z);
      }
      return (
        K === 0 && this.param.enable_short_term && (P = H),
        { difficulty: this.next_difficulty(X, Q), stability: P }
      );
    }
  }
  function m() {
    let J = this.review_time.getTime(),
      K = this.current.reps,
      Q = this.current.difficulty * this.current.stability;
    return `${J}_${K}_${Q}`;
  }
  var _ = ((J) => ((J.SCHEDULER = "Scheduler"), (J.SEED = "Seed"), J))(_ || {});
  class G {
    last;
    current;
    review_time;
    next = new Map();
    algorithm;
    initSeedStrategy;
    constructor(J, K, Q, X = { seed: m }) {
      ((this.algorithm = Q),
        (this.initSeedStrategy = X.seed.bind(this)),
        (this.last = E.card(J)),
        (this.current = E.card(J)),
        (this.review_time = E.time(K)),
        this.init());
    }
    init() {
      let { state: J, last_review: K } = this.current,
        Q = 0;
      (J !== L.New && K && (Q = z0(K, this.review_time)),
        (this.current.last_review = this.review_time),
        (this.current.elapsed_days = Q),
        (this.current.reps += 1),
        (this.algorithm.seed = this.initSeedStrategy()));
    }
    preview() {
      return {
        [T.Again]: this.review(T.Again),
        [T.Hard]: this.review(T.Hard),
        [T.Good]: this.review(T.Good),
        [T.Easy]: this.review(T.Easy),
        [Symbol.iterator]: this.previewIterator.bind(this),
      };
    }
    *previewIterator() {
      for (let J of I0) yield this.review(J);
    }
    review(J) {
      let { state: K } = this.last,
        Q;
      switch (K) {
        case L.New:
          Q = this.newState(J);
          break;
        case L.Learning:
        case L.Relearning:
          Q = this.learningState(J);
          break;
        case L.Review:
          Q = this.reviewState(J);
          break;
      }
      if (Q) return Q;
      throw Error("Invalid grade");
    }
    buildLog(J) {
      let { last_review: K, due: Q, elapsed_days: X } = this.last;
      return {
        rating: J,
        state: this.current.state,
        due: K || Q,
        stability: this.current.stability,
        difficulty: this.current.difficulty,
        elapsed_days: this.current.elapsed_days,
        last_elapsed_days: X,
        scheduled_days: this.current.scheduled_days,
        review: this.review_time,
      };
    }
  }
  class g extends G {
    newState(J) {
      let K = this.next.get(J);
      if (K) return K;
      let Q = E.card(this.current);
      switch (
        ((Q.difficulty = this.algorithm.init_difficulty(J)),
        (Q.stability = this.algorithm.init_stability(J)),
        J)
      ) {
        case T.Again:
          ((Q.scheduled_days = 0), (Q.due = this.review_time.scheduler(1)), (Q.state = L.Learning));
          break;
        case T.Hard:
          ((Q.scheduled_days = 0), (Q.due = this.review_time.scheduler(5)), (Q.state = L.Learning));
          break;
        case T.Good:
          ((Q.scheduled_days = 0),
            (Q.due = this.review_time.scheduler(10)),
            (Q.state = L.Learning));
          break;
        case T.Easy: {
          let Z = this.algorithm.next_interval(Q.stability, this.current.elapsed_days);
          ((Q.scheduled_days = Z),
            (Q.due = this.review_time.scheduler(Z, !0)),
            (Q.state = L.Review));
          break;
        }
        default:
          throw Error("Invalid grade");
      }
      let X = { card: Q, log: this.buildLog(J) };
      return (this.next.set(J, X), X);
    }
    learningState(J) {
      let K = this.next.get(J);
      if (K) return K;
      let { state: Q, difficulty: X, stability: Z } = this.last,
        I = E.card(this.current),
        O = this.current.elapsed_days;
      switch (
        ((I.difficulty = this.algorithm.next_difficulty(X, J)),
        (I.stability = this.algorithm.next_short_term_stability(Z, J)),
        J)
      ) {
        case T.Again: {
          ((I.scheduled_days = 0), (I.due = this.review_time.scheduler(5, !1)), (I.state = Q));
          break;
        }
        case T.Hard: {
          ((I.scheduled_days = 0), (I.due = this.review_time.scheduler(10)), (I.state = Q));
          break;
        }
        case T.Good: {
          let H = this.algorithm.next_interval(I.stability, O);
          ((I.scheduled_days = H),
            (I.due = this.review_time.scheduler(H, !0)),
            (I.state = L.Review));
          break;
        }
        case T.Easy: {
          let H = this.algorithm.next_short_term_stability(Z, T.Good),
            P = this.algorithm.next_interval(H, O),
            $ = Math.max(this.algorithm.next_interval(I.stability, O), P + 1);
          ((I.scheduled_days = $),
            (I.due = this.review_time.scheduler($, !0)),
            (I.state = L.Review));
          break;
        }
        default:
          throw Error("Invalid grade");
      }
      let z = { card: I, log: this.buildLog(J) };
      return (this.next.set(J, z), z);
    }
    reviewState(J) {
      let K = this.next.get(J);
      if (K) return K;
      let Q = this.current.elapsed_days,
        { difficulty: X, stability: Z } = this.last,
        I = this.algorithm.forgetting_curve(Q, Z),
        O = E.card(this.current),
        z = E.card(this.current),
        H = E.card(this.current),
        P = E.card(this.current);
      (this.next_ds(O, z, H, P, X, Z, I),
        this.next_interval(O, z, H, P, Q),
        this.next_state(O, z, H, P),
        (O.lapses += 1));
      let $ = { card: O, log: this.buildLog(T.Again) },
        Y = { card: z, log: super.buildLog(T.Hard) },
        D = { card: H, log: super.buildLog(T.Good) },
        A = { card: P, log: super.buildLog(T.Easy) };
      return (
        this.next.set(T.Again, $),
        this.next.set(T.Hard, Y),
        this.next.set(T.Good, D),
        this.next.set(T.Easy, A),
        this.next.get(J)
      );
    }
    next_ds(J, K, Q, X, Z, I, O) {
      J.difficulty = this.algorithm.next_difficulty(Z, T.Again);
      let z = I / Math.exp(this.algorithm.parameters.w[17] * this.algorithm.parameters.w[18]),
        H = this.algorithm.next_forget_stability(Z, I, O);
      ((J.stability = V(+z.toFixed(8), U, H)),
        (K.difficulty = this.algorithm.next_difficulty(Z, T.Hard)),
        (K.stability = this.algorithm.next_recall_stability(Z, I, O, T.Hard)),
        (Q.difficulty = this.algorithm.next_difficulty(Z, T.Good)),
        (Q.stability = this.algorithm.next_recall_stability(Z, I, O, T.Good)),
        (X.difficulty = this.algorithm.next_difficulty(Z, T.Easy)),
        (X.stability = this.algorithm.next_recall_stability(Z, I, O, T.Easy)));
    }
    next_interval(J, K, Q, X, Z) {
      let I, O;
      ((I = this.algorithm.next_interval(K.stability, Z)),
        (O = this.algorithm.next_interval(Q.stability, Z)),
        (I = Math.min(I, O)),
        (O = Math.max(O, I + 1)));
      let z = Math.max(this.algorithm.next_interval(X.stability, Z), O + 1);
      ((J.scheduled_days = 0),
        (J.due = this.review_time.scheduler(5)),
        (K.scheduled_days = I),
        (K.due = this.review_time.scheduler(I, !0)),
        (Q.scheduled_days = O),
        (Q.due = this.review_time.scheduler(O, !0)),
        (X.scheduled_days = z),
        (X.due = this.review_time.scheduler(z, !0)));
    }
    next_state(J, K, Q, X) {
      ((J.state = L.Relearning), (K.state = L.Review), (Q.state = L.Review), (X.state = L.Review));
    }
  }
  class v extends G {
    newState(J) {
      let K = this.next.get(J);
      if (K) return K;
      ((this.current.scheduled_days = 0), (this.current.elapsed_days = 0));
      let Q = E.card(this.current),
        X = E.card(this.current),
        Z = E.card(this.current),
        I = E.card(this.current);
      return (
        this.init_ds(Q, X, Z, I),
        this.next_interval(Q, X, Z, I, 0),
        this.next_state(Q, X, Z, I),
        this.update_next(Q, X, Z, I),
        this.next.get(J)
      );
    }
    init_ds(J, K, Q, X) {
      ((J.difficulty = this.algorithm.init_difficulty(T.Again)),
        (J.stability = this.algorithm.init_stability(T.Again)),
        (K.difficulty = this.algorithm.init_difficulty(T.Hard)),
        (K.stability = this.algorithm.init_stability(T.Hard)),
        (Q.difficulty = this.algorithm.init_difficulty(T.Good)),
        (Q.stability = this.algorithm.init_stability(T.Good)),
        (X.difficulty = this.algorithm.init_difficulty(T.Easy)),
        (X.stability = this.algorithm.init_stability(T.Easy)));
    }
    learningState(J) {
      return this.reviewState(J);
    }
    reviewState(J) {
      let K = this.next.get(J);
      if (K) return K;
      let Q = this.current.elapsed_days,
        { difficulty: X, stability: Z } = this.last,
        I = this.algorithm.forgetting_curve(Q, Z),
        O = E.card(this.current),
        z = E.card(this.current),
        H = E.card(this.current),
        P = E.card(this.current);
      return (
        this.next_ds(O, z, H, P, X, Z, I),
        this.next_interval(O, z, H, P, Q),
        this.next_state(O, z, H, P),
        (O.lapses += 1),
        this.update_next(O, z, H, P),
        this.next.get(J)
      );
    }
    next_ds(J, K, Q, X, Z, I, O) {
      J.difficulty = this.algorithm.next_difficulty(Z, T.Again);
      let z = this.algorithm.next_forget_stability(Z, I, O);
      ((J.stability = V(I, U, z)),
        (K.difficulty = this.algorithm.next_difficulty(Z, T.Hard)),
        (K.stability = this.algorithm.next_recall_stability(Z, I, O, T.Hard)),
        (Q.difficulty = this.algorithm.next_difficulty(Z, T.Good)),
        (Q.stability = this.algorithm.next_recall_stability(Z, I, O, T.Good)),
        (X.difficulty = this.algorithm.next_difficulty(Z, T.Easy)),
        (X.stability = this.algorithm.next_recall_stability(Z, I, O, T.Easy)));
    }
    next_interval(J, K, Q, X, Z) {
      let I, O, z, H;
      ((I = this.algorithm.next_interval(J.stability, Z)),
        (O = this.algorithm.next_interval(K.stability, Z)),
        (z = this.algorithm.next_interval(Q.stability, Z)),
        (H = this.algorithm.next_interval(X.stability, Z)),
        (I = Math.min(I, O)),
        (O = Math.max(O, I + 1)),
        (z = Math.max(z, O + 1)),
        (H = Math.max(H, z + 1)),
        (J.scheduled_days = I),
        (J.due = this.review_time.scheduler(I, !0)),
        (K.scheduled_days = O),
        (K.due = this.review_time.scheduler(O, !0)),
        (Q.scheduled_days = z),
        (Q.due = this.review_time.scheduler(z, !0)),
        (X.scheduled_days = H),
        (X.due = this.review_time.scheduler(H, !0)));
    }
    next_state(J, K, Q, X) {
      ((J.state = L.Review), (K.state = L.Review), (Q.state = L.Review), (X.state = L.Review));
    }
    update_next(J, K, Q, X) {
      let Z = { card: J, log: this.buildLog(T.Again) },
        I = { card: K, log: super.buildLog(T.Hard) },
        O = { card: Q, log: super.buildLog(T.Good) },
        z = { card: X, log: super.buildLog(T.Easy) };
      (this.next.set(T.Again, Z),
        this.next.set(T.Hard, I),
        this.next.set(T.Good, O),
        this.next.set(T.Easy, z));
    }
  }
  class c {
    fsrs;
    constructor(J) {
      this.fsrs = J;
    }
    replay(J, K, Q) {
      return this.fsrs.next(J, K, Q);
    }
    handleManualRating(J, K, Q, X, Z, I, O) {
      if (typeof K > "u") throw Error("reschedule: state is required for manual rating");
      let z, H;
      if (K === L.New)
        ((z = {
          rating: T.Manual,
          state: K,
          due: O ?? Q,
          stability: J.stability,
          difficulty: J.difficulty,
          elapsed_days: X,
          last_elapsed_days: J.elapsed_days,
          scheduled_days: J.scheduled_days,
          review: Q,
        }),
          (H = N(Q)),
          (H.last_review = Q));
      else {
        if (typeof O > "u") throw Error("reschedule: due is required for manual rating");
        let P = O.diff(Q, "days");
        ((z = {
          rating: T.Manual,
          state: J.state,
          due: J.last_review || J.due,
          stability: J.stability,
          difficulty: J.difficulty,
          elapsed_days: X,
          last_elapsed_days: J.elapsed_days,
          scheduled_days: J.scheduled_days,
          review: Q,
        }),
          (H = {
            ...J,
            state: K,
            due: O,
            last_review: Q,
            stability: Z || J.stability,
            difficulty: I || J.difficulty,
            elapsed_days: X,
            scheduled_days: P,
            reps: J.reps + 1,
          }));
      }
      return { card: H, log: z };
    }
    reschedule(J, K) {
      let Q = [],
        X = N(J.due);
      for (let Z of K) {
        let I;
        if (((Z.review = E.time(Z.review)), Z.rating === T.Manual)) {
          let O = 0;
          (X.state !== L.New && X.last_review && (O = Z.review.diff(X.last_review, "days")),
            (I = this.handleManualRating(
              X,
              Z.state,
              Z.review,
              O,
              Z.stability,
              Z.difficulty,
              Z.due ? E.time(Z.due) : void 0,
            )));
        } else I = this.replay(X, Z.review, Z.rating);
        (Q.push(I), (X = I.card));
      }
      return Q;
    }
    calculateManualRecord(J, K, Q, X) {
      if (!Q) return null;
      let { card: Z, log: I } = Q,
        O = E.card(J);
      return O.due.getTime() === Z.due.getTime()
        ? null
        : ((O.scheduled_days = Z.due.diff(O.due, "days")),
          this.handleManualRating(
            O,
            Z.state,
            E.time(K),
            I.elapsed_days,
            X ? Z.stability : void 0,
            X ? Z.difficulty : void 0,
            Z.due,
          ));
    }
  }
  class n extends y {
    strategyHandler = new Map();
    Scheduler;
    constructor(J) {
      super(J);
      let { enable_short_term: K } = this.parameters;
      this.Scheduler = K ? g : v;
    }
    params_handler_proxy() {
      let J = this;
      return {
        set: function (K, Q, X) {
          return (
            Q === "request_retention" && Number.isFinite(X)
              ? (J.intervalModifier = J.calculate_interval_modifier(Number(X)))
              : Q === "enable_short_term" && (J.Scheduler = X === !0 ? g : v),
            Reflect.set(K, Q, X),
            !0
          );
        },
      };
    }
    useStrategy(J, K) {
      return (this.strategyHandler.set(J, K), this);
    }
    clearStrategy(J) {
      return (J ? this.strategyHandler.delete(J) : this.strategyHandler.clear(), this);
    }
    getScheduler(J, K) {
      let Q = this.strategyHandler.get(_.SEED);
      return new (this.strategyHandler.get(_.SCHEDULER) || this.Scheduler)(J, K, this, {
        seed: Q || m,
      });
    }
    repeat(J, K, Q) {
      let X = this.getScheduler(J, K).preview();
      return Q && typeof Q == "function" ? Q(X) : X;
    }
    next(J, K, Q, X) {
      let Z = this.getScheduler(J, K),
        I = E.rating(Q);
      if (I === T.Manual) throw Error("Cannot review a manual rating");
      let O = Z.review(I);
      return X && typeof X == "function" ? X(O) : O;
    }
    get_retrievability(J, K, Q = !0) {
      let X = E.card(J);
      K = K ? E.time(K) : new Date();
      let Z = X.state !== L.New ? Math.max(K.diff(X.last_review, "days"), 0) : 0,
        I = X.state !== L.New ? this.forgetting_curve(Z, +X.stability.toFixed(8)) : 0;
      return Q ? `${(I * 100).toFixed(2)}%` : I;
    }
    rollback(J, K, Q) {
      let X = E.card(J),
        Z = E.review_log(K);
      if (Z.rating === T.Manual) throw Error("Cannot rollback a manual rating");
      let I, O, z;
      switch (Z.state) {
        case L.New:
          ((I = Z.due), (O = void 0), (z = 0));
          break;
        case L.Learning:
        case L.Relearning:
        case L.Review:
          ((I = Z.review),
            (O = Z.due),
            (z = X.lapses - (Z.rating === T.Again && Z.state === L.Review ? 1 : 0)));
          break;
      }
      let H = {
        ...X,
        due: I,
        stability: Z.stability,
        difficulty: Z.difficulty,
        elapsed_days: Z.last_elapsed_days,
        scheduled_days: Z.scheduled_days,
        reps: Math.max(0, X.reps - 1),
        lapses: Math.max(0, z),
        state: Z.state,
        last_review: O,
      };
      return Q && typeof Q == "function" ? Q(H) : H;
    }
    forget(J, K, Q = !1, X) {
      let Z = E.card(J);
      K = E.time(K);
      let I = Z.state === L.New ? 0 : K.diff(Z.last_review, "days"),
        O = {
          rating: T.Manual,
          state: Z.state,
          due: Z.due,
          stability: Z.stability,
          difficulty: Z.difficulty,
          elapsed_days: 0,
          last_elapsed_days: Z.elapsed_days,
          scheduled_days: I,
          review: K,
        },
        z = {
          card: {
            ...Z,
            due: K,
            stability: 0,
            difficulty: 0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: Q ? 0 : Z.reps,
            lapses: Q ? 0 : Z.lapses,
            state: L.New,
            last_review: Z.last_review,
          },
          log: O,
        };
      return X && typeof X == "function" ? X(z) : z;
    }
    reschedule(J, K = [], Q = {}) {
      let {
        recordLogHandler: X,
        reviewsOrderBy: Z,
        skipManual: I = !0,
        now: O = new Date(),
        update_memory_state: z = !1,
      } = Q;
      (Z && typeof Z == "function" && K.sort(Z), I && (K = K.filter((A) => A.rating !== T.Manual)));
      let H = new c(this),
        P = H.reschedule(Q.first_card || N(), K),
        $ = P.length,
        Y = E.card(J),
        D = H.calculateManualRecord(Y, O, $ ? P[$ - 1] : void 0, z);
      return X && typeof X == "function"
        ? { collections: P.map(X), reschedule_item: D ? X(D) : null }
        : { collections: P, reschedule_item: D };
    }
  }
  var h = (J) => new n(J || {});
  function W(J) {
    return new Promise((K, Q) => {
      ((J.oncomplete = J.onsuccess = () => K(J.result)),
        (J.onabort = J.onerror = () => Q(J.error)));
    });
  }
  function b(J, K) {
    let Q,
      X = () => {
        if (Q) return Q;
        let Z = indexedDB.open(J);
        return (
          (Z.onupgradeneeded = () => Z.result.createObjectStore(K)),
          (Q = W(Z)),
          Q.then(
            (I) => {
              I.onclose = () => (Q = void 0);
            },
            () => {},
          ),
          Q
        );
      };
    return (Z, I) => X().then((O) => I(O.transaction(K, Z).objectStore(K)));
  }
  var R;
  function B() {
    if (!R) R = b("keyval-store", "keyval");
    return R;
  }
  function d(J, K = B()) {
    return K("readonly", (Q) => W(Q.get(J)));
  }
  function l(J, K, Q = B()) {
    return Q("readwrite", (X) => {
      return (X.put(K, J), W(X.transaction));
    });
  }
  function u(J, K = B()) {
    return K("readwrite", (Q) => {
      return (Q.delete(J), W(Q.transaction));
    });
  }
  function a(J = B()) {
    return J("readwrite", (K) => {
      return (K.clear(), W(K.transaction));
    });
  }
  function W0(J, K) {
    return (
      (J.openCursor().onsuccess = function () {
        if (!this.result) return;
        (K(this.result), this.result.continue());
      }),
      W(J.transaction)
    );
  }
  function o(J = B()) {
    return J("readonly", (K) => {
      if (K.getAllKeys) return W(K.getAllKeys());
      let Q = [];
      return W0(K, (X) => Q.push(X.key)).then(() => Q);
    });
  }
  // Expose LiankiDeps globally
  if (typeof window !== "undefined") {
    window.LiankiDeps = Y0;
  }
})();

/**
 * Offline-First Core for Lianki Userscript
 *
 * This file contains:
 * - Hybrid Logical Clock (HLC) implementation
 * - GM_setValue storage layer (LDF eviction, 2000 card cap)
 * - Local FSRS calculations
 * - Background sync mechanism
 */

// ============================================================================
// Hybrid Logical Clock (HLC) - CRDT Conflict Resolution
// ============================================================================

/**
 * @typedef {Object} HLC
 * @property {number} timestamp - Physical clock (Date.now())
 * @property {number} counter - Logical counter for same timestamp
 * @property {string} deviceId - Device/session identifier
 */

/**
 * Compare two HLC timestamps
 * Returns: < 0 if a < b, 0 if equal, > 0 if a > b
 */
function compareHLC(a, b) {
  if (!a) return -1;
  if (!b) return 1;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId.localeCompare(b.deviceId);
}

/**
 * Generate new HLC timestamp
 */
function newHLC(deviceId, lastHLC = null) {
  const now = Date.now();

  if (!lastHLC || now > lastHLC.timestamp) {
    return { timestamp: now, counter: 0, deviceId };
  }

  // Same timestamp - increment counter
  return {
    timestamp: lastHLC.timestamp,
    counter: lastHLC.counter + 1,
    deviceId,
  };
}

/**
 * Generate device ID (persisted in GM_setValue)
 */
function getOrCreateDeviceId() {
  let deviceId = GM_getValue("lk:deviceId", "");

  if (!deviceId) {
    // Generate UUID v4
    deviceId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    GM_setValue("lk:deviceId", deviceId);
  }

  return deviceId;
}

// ============================================================================
// GM_setValue Storage Layer
// ============================================================================

// ── GM_setValue Storage Layer ────────────────────────────────────────────────

const CARD_PREFIX = "lk:c:";
const INDEX_KEY = "lk:card-index";
const MAX_CARDS = 2000;

function hashUrl(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

class GMCardStorage {
  _index() {
    return JSON.parse(GM_getValue(INDEX_KEY, "[]"));
  }
  _saveIndex(idx) {
    GM_setValue(INDEX_KEY, JSON.stringify(idx));
  }

  getCard(url) {
    const raw = GM_getValue(CARD_PREFIX + hashUrl(url), "");
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c._url === url ? c : null; // hash collision guard
  }

  setCard(url, note, hlc, dirty = false) {
    const hash = hashUrl(url);
    const key = CARD_PREFIX + hash;
    let idx = this._index();
    const pos = idx.findIndex((e) => e.url === url);
    const entry = { url, due: note.card.due, hash };
    if (pos >= 0) {
      idx[pos] = entry;
    } else {
      if (idx.length >= MAX_CARDS) {
        // LDF: evict furthest due
        const maxI = idx.reduce(
          (mi, e, i, a) => (new Date(e.due) > new Date(a[mi].due) ? i : mi),
          0,
        );
        GM_deleteValue(CARD_PREFIX + idx[maxI].hash);
        idx.splice(maxI, 1);
      }
      idx.push(entry);
    }
    this._saveIndex(idx);
    GM_setValue(key, JSON.stringify({ _url: url, note, hlc, dirty }));
  }

  deleteCard(url) {
    GM_deleteValue(CARD_PREFIX + hashUrl(url));
    this._saveIndex(this._index().filter((e) => e.url !== url));
  }

  getAllCards() {
    return this._index()
      .map((e) => {
        const raw = GM_getValue(CARD_PREFIX + e.hash, "");
        return raw ? { url: e.url, ...JSON.parse(raw) } : null;
      })
      .filter(Boolean);
  }

  getDueCards(limit = 10) {
    const now = new Date();
    return this._index()
      .filter((e) => new Date(e.due) <= now)
      .sort((a, b) => new Date(a.due) - new Date(b.due))
      .slice(0, limit)
      .map((e) => {
        const raw = GM_getValue(CARD_PREFIX + e.hash, "");
        return raw ? { url: e.url, ...JSON.parse(raw) } : null;
      })
      .filter(Boolean);
  }
}

class GMConfigStorage {
  getConfig() {
    const cfg = JSON.parse(GM_getValue("lk:config", "{}"));
    if (!cfg.lastSyncHLC) cfg.lastSyncHLC = null;
    if (!cfg.lastSyncTime) cfg.lastSyncTime = 0;
    return cfg;
  }
  setConfig(cfg) {
    GM_setValue("lk:config", JSON.stringify(cfg));
  }
  updateLastSync(hlc) {
    this.setConfig({ ...this.getConfig(), lastSyncHLC: hlc, lastSyncTime: Date.now() });
  }
}

class GMQueueStorage {
  getQueue() {
    return JSON.parse(GM_getValue("lk:queue", "[]"));
  }
  addToQueue(action, data, hlc) {
    const q = this.getQueue();
    q.push({
      id: Date.now() + Math.random(),
      action,
      data,
      hlc,
      retries: 0,
      createdAt: Date.now(),
    });
    GM_setValue("lk:queue", JSON.stringify(q));
  }
  removeFromQueue(id) {
    GM_setValue("lk:queue", JSON.stringify(this.getQueue().filter((e) => e.id !== id)));
  }
  updateQueueItem(id, updates) {
    GM_setValue(
      "lk:queue",
      JSON.stringify(this.getQueue().map((e) => (e.id === id ? { ...e, ...updates } : e))),
    );
  }
}

// ============================================================================
// GM→IndexedDB Sync (runs on lianki.com to expose cached cards to site UI)
// ============================================================================

async function syncToSiteDB() {
  const cs = new GMCardStorage();
  const index = cs._index();
  if (!index.length) return;
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("lianki-keyval", 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore("keyval");
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    const tx = db.transaction("keyval", "readwrite");
    const store = tx.objectStore("keyval");
    for (const entry of index) {
      const raw = GM_getValue(CARD_PREFIX + entry.hash, "");
      if (!raw) continue;
      const { note, hlc, dirty } = JSON.parse(raw);
      if (!note?.card) continue;
      store.put(
        {
          url: note.url || entry.url,
          title: note.title || note.url || entry.url,
          card: note.card,
          log: note.log || [],
          hlc: hlc || note.hlc,
          synced: !dirty,
        },
        "card:" + (note.url || entry.url),
      );
    }
    store.put(index.length, "meta:gm-count");
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
    db.close();
    console.log(`[Lianki] Synced ${index.length} cards to site IndexedDB`);
  } catch (err) {
    console.error("[Lianki] syncToSiteDB failed:", err);
  }
}

// ============================================================================
// Local FSRS Calculations (using bundled ts-fsrs)
// ============================================================================

class LocalFSRS {
  constructor(params = null) {
    const { fsrs, generatorParameters, Rating } = window.LiankiDeps;

    this.Rating = Rating;
    this.params = params || generatorParameters({});
    this.scheduler = fsrs(this.params);
  }

  /**
   * Calculate review options for a card
   * Returns array of 4 options (Again, Hard, Good, Easy)
   */
  calculateOptions(card, now = new Date()) {
    const scheduleInfo = this.scheduler.repeat(card, now);

    return [
      {
        rating: 1,
        label: "Again",
        card: scheduleInfo[this.Rating.Again].card,
        log: scheduleInfo[this.Rating.Again].log,
        due: this.formatDue(scheduleInfo[this.Rating.Again].card.due),
      },
      {
        rating: 2,
        label: "Hard",
        card: scheduleInfo[this.Rating.Hard].card,
        log: scheduleInfo[this.Rating.Hard].log,
        due: this.formatDue(scheduleInfo[this.Rating.Hard].card.due),
      },
      {
        rating: 3,
        label: "Good",
        card: scheduleInfo[this.Rating.Good].card,
        log: scheduleInfo[this.Rating.Good].log,
        due: this.formatDue(scheduleInfo[this.Rating.Good].card.due),
      },
      {
        rating: 4,
        label: "Easy",
        card: scheduleInfo[this.Rating.Easy].card,
        log: scheduleInfo[this.Rating.Easy].log,
        due: this.formatDue(scheduleInfo[this.Rating.Easy].card.due),
      },
    ];
  }

  /**
   * Format due date as relative string
   */
  formatDue(dueDate) {
    const now = new Date();
    const diffMs = new Date(dueDate) - now;
    const diffMins = Math.round(diffMs / 60000);
    const diffHours = Math.round(diffMs / 3600000);
    const diffDays = Math.round(diffMs / 86400000);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 30) return `${diffDays}d`;

    const diffMonths = Math.round(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo`;

    const diffYears = Math.round(diffDays / 365);
    return `${diffYears}y`;
  }

  newCard() {
    const now = new Date();
    return {
      due: now,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: 0, // State.New
      last_review: now,
    };
  }

  /**
   * Apply review to card
   */
  applyReview(card, rating, now = new Date()) {
    const scheduleInfo = this.scheduler.repeat(card, now);
    const ratingKey = [
      this.Rating.Manual,
      this.Rating.Again,
      this.Rating.Hard,
      this.Rating.Good,
      this.Rating.Easy,
    ][rating];

    return scheduleInfo[ratingKey];
  }
}

function main() {
  // Set global marker so web UI knows userscript is installed
  window.LIANKI_USERSCRIPT_INSTALLED = true;

  // ── Origin ─────────────────────────────────────────────────────────────────
  // Auto-detected from @downloadURL so beta.lianki.com works too.
  // Normalize bare lianki.com → www.lianki.com: __Host- cookies bind to exact hostname.
  const ORIGIN = (() => {
    try {
      const u = new URL(GM_info?.script?.downloadURL || "");
      if (u.hostname === "lianki.com") u.hostname = "www.lianki.com";
      return u.origin;
    } catch {
      return "https://www.lianki.com";
    }
  })();

  // ── URL normalization ───────────────────────────────────────────────────────
  function normalizeUrl(href) {
    try {
      const u = new URL(href);
      // youtu.be/ID → youtube.com/watch?v=ID
      if (u.hostname === "youtu.be") {
        const id = u.pathname.slice(1);
        u.hostname = "www.youtube.com";
        u.pathname = "/watch";
        u.searchParams.set("v", id);
      }
      // m.example.com → www.example.com
      if (u.hostname.startsWith("m.")) u.hostname = "www." + u.hostname.slice(2);
      // Strip tracking & session params
      for (const p of [
        "si",
        "pp",
        "feature",
        "ref",
        "source",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "igshid",
      ])
        u.searchParams.delete(p);
      u.searchParams.sort();
      return u.toString();
    } catch {
      return href;
    }
  }

  // On the Lianki site itself: sync GM cards to IndexedDB for offline display, then exit
  if (location.hostname === new URL(ORIGIN).hostname) {
    setTimeout(() => syncToSiteDB(), 500);
    return () => {};
  }

  const ac = new AbortController();
  const { signal } = ac;

  // ── Constants ──────────────────────────────────────────────────────────────
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // User preferences (loaded from API)
  let userPreferences = {
    mobileExcludeDomains: [], // default: no filters
  };

  // Load preferences on startup (called after api() is defined)
  async function loadPreferences() {
    try {
      const cached = GM_getValue("lk:preferences", "");
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        // Use cached if less than 1 hour old
        if (Date.now() - ts < 60 * 60 * 1000) {
          userPreferences = data;
          return;
        }
      }

      // Fetch fresh preferences
      const prefs = await api("/api/preferences");
      userPreferences = prefs;
      GM_setValue("lk:preferences", JSON.stringify({ data: prefs, ts: Date.now() }));
    } catch (err) {
      console.log("[Lianki] Failed to load preferences, using defaults:", err);
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    phase: "idle",
    noteId: null,
    options: null,
    error: null,
    message: null,
    notes: "",
    notesSynced: true,
  };
  let fab = null;
  let dialog = null;
  let prefetchedNextUrl = null; // populated while user reads current card
  let prefetchLink = null; // <link rel="prefetch"> element for next page
  let videoObserver = null; // MutationObserver for video presence

  // ── Auto-update ────────────────────────────────────────────────────────────
  const CURRENT_VERSION = GM_info?.script?.version ?? "0.0.0";
  let updatePrompted = false;

  function isNewerVersion(a, b) {
    const seg = (v) => v.split(".").map((n) => parseInt(n) || 0);
    const [aa, ab, ac2] = seg(a);
    const [ba, bb, bc] = seg(b);
    return aa !== ba ? aa > ba : ab !== bb ? ab > bb : ac2 > bc;
  }

  function checkVersion(r) {
    if (updatePrompted) return;
    const sv = r.headers.get("x-lianki-version");
    if (sv && isNewerVersion(sv, CURRENT_VERSION)) {
      updatePrompted = true;
      window.open(`${ORIGIN}/lianki.user.js`, "_blank");
    }
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // Inline wrapper around GM_xmlhttpRequest — avoids gm-fetch's set-cookie
  // header bug that throws on strict mobile environments.
  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const token = GM_getValue("lk:token", "");
      const headers = { ...opts.headers };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      GM_xmlhttpRequest({
        method: (opts.method || "GET").toUpperCase(),
        url: String(url),
        headers,
        data: opts.body ?? undefined,
        withCredentials: opts.credentials === "include",
        onload(resp) {
          const hdrs = {};
          for (const line of resp.responseHeaders.split("\r\n")) {
            const i = line.indexOf(": ");
            if (i > 0) {
              const name = line.slice(0, i).toLowerCase();
              if (name !== "set-cookie") hdrs[name] = line.slice(i + 2);
            }
          }
          resolve({
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            headers: { get: (n) => hdrs[n.toLowerCase()] ?? null },
            json() {
              try {
                return Promise.resolve(JSON.parse(resp.responseText));
              } catch {
                const preview = resp.responseText.slice(0, 120).replace(/\s+/g, " ").trim();
                const err = new Error(`Login required (got: ${preview})`);
                err.details = resp.responseText.slice(0, 2000);
                err.statusCode = resp.status;
                return Promise.reject(err);
              }
            },
            text: () => Promise.resolve(resp.responseText),
          });
        },
        onerror() {
          reject(new Error("Network error"));
        },
        onabort() {
          reject(new Error("Request aborted"));
        },
      });
    });
  }

  // ── API ────────────────────────────────────────────────────────────────────
  const api = (path, opts = {}) =>
    gmFetch(`${ORIGIN}${path}`, { credentials: "include", ...opts }).then((r) => {
      if (r.status === 401) {
        const e = new Error("Login required");
        e.status = 401;
        throw e;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      checkVersion(r);
      return r.json();
    });

  // ── Cache (keyv-style, GM_setValue as cross-origin storage adapter) ────────
  function gmCache(key, ttlMs, fn) {
    try {
      const raw = GM_getValue(key);
      if (raw) {
        const { v, exp } = JSON.parse(raw);
        if (Date.now() < exp) return Promise.resolve(v);
      }
    } catch {}
    return fn().then((v) => {
      GM_setValue(key, JSON.stringify({ v, exp: Date.now() + ttlMs }));
      return v;
    });
  }

  function gmCacheInvalidate(key) {
    GM_setValue(key, "");
  }

  // ── API helpers ────────────────────────────────────────────────────────────
  const noteKey = (url) => `lk:note:${url}`;

  // Cache addNote by normalized URL for 10 min — skips round-trip on repeat visits
  const addNote = (url, title) =>
    gmCache(noteKey(url), 10 * 60 * 1000, () =>
      api("/api/fsrs/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title }),
      }),
    );

  // Build excludeDomains query param for filtering next card
  const buildExcludeDomainsParam = () => {
    if (!isMobile) return "";
    const domains = userPreferences.mobileExcludeDomains || [];
    if (domains.length === 0) return "";
    return `&excludeDomains=${domains.join(",")}`;
  };

  const saveNotes = (id, notes) =>
    api(`/api/fsrs/notes?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  const getOptions = (id) => api(`/api/fsrs/options?id=${encodeURIComponent(id)}`);
  const submitReview = (id, rating) =>
    api(`/api/fsrs/review/${rating}/?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
  const deleteNote = (id) =>
    api(`/api/fsrs/delete?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
  const getNextUrl = () => api(`/api/fsrs/next-url?${buildExcludeDomainsParam().slice(1)}`);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const btn = (bg, extra = "") =>
    `all:initial;display:inline-block;box-sizing:border-box;background:${bg};color:${bg === "transparent" ? "var(--lk-fg)" : "#eee"};border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;min-width:60px;line-height:1.5;text-align:center;${extra}`;

  // Prefetch next page for faster navigation
  function prefetchNextPage(pageUrl) {
    if (!pageUrl) return;

    // Remove old prefetch link if exists
    if (prefetchLink) {
      prefetchLink.remove();
      prefetchLink = null;
    }

    // Create and append new prefetch link
    prefetchLink = document.createElement("link");
    prefetchLink.rel = "prefetch";
    prefetchLink.href = pageUrl;
    prefetchLink.as = "document";
    document.head.appendChild(prefetchLink);
    console.log("[Lianki] Prefetching next page:", pageUrl);
  }

  // ── UI: combined FAB + speed controls ─────────────────────────────────────
  function createUI() {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "fixed",
      zIndex: "2147483647",
      display: "flex",
      gap: "0",
      alignItems: "center",
      userSelect: "none",
      touchAction: "none",
      background: "rgba(20,20,20,0.82)",
      borderRadius: "999px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      overflow: "hidden",
    });

    let isDragged = false;
    const BTN_BASE =
      "border:none;cursor:pointer;background:transparent;color:#eee;" +
      "padding:10px 14px;font-size:15px;font-weight:bold;touch-action:manipulation;" +
      "transition:background 0.2s;";
    const BTN_HOVER = "background:rgba(255,255,255,0.1);";
    const makeBtn = (text, title, action) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.style.cssText = BTN_BASE;
      b.addEventListener("mouseenter", () => {
        if (!isDragged) b.style.background = "rgba(255,255,255,0.1)";
      });
      b.addEventListener("mouseleave", () => {
        b.style.background = "transparent";
      });
      b.addEventListener("click", (e) => {
        if (isDragged) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        action();
      });
      return b;
    };

    const slowerBtn = makeBtn("⏪", "Slower (,/v)", () => pardon(-3, 0.7));
    const liankiBtn = makeBtn("🔖", "Lianki (Alt+F)", () =>
      dialog ? closeDialog() : openDialog(),
    );
    const fasterBtn = makeBtn("⏩", "Faster (./b)", () => pardon(0, 1.2));

    // Add separators between buttons
    const makeSeparator = () => {
      const sep = document.createElement("div");
      sep.style.cssText =
        "width:1px;height:24px;background:rgba(255,255,255,0.15);align-self:center;";
      return sep;
    };

    container.append(slowerBtn, makeSeparator(), liankiBtn, makeSeparator(), fasterBtn);

    // Hide/show video control buttons based on video presence
    const updateVideoButtonVisibility = () => {
      const hasVideo = document.querySelector("video,audio") !== null;
      const display = hasVideo ? "" : "none";
      slowerBtn.style.display = display;
      fasterBtn.style.display = display;
      // Also hide separators when video buttons are hidden
      const separators = container.querySelectorAll("div");
      if (hasVideo) {
        separators[0].style.display = "";
        separators[1].style.display = "";
      } else {
        separators[0].style.display = "none";
        separators[1].style.display = "none";
      }
    };

    // Update border radius based on edge proximity
    const EDGE_THRESHOLD = 5; // pixels from edge to remove radius
    const updateBorderRadius = () => {
      const r = container.getBoundingClientRect();
      const atLeft = r.left <= EDGE_THRESHOLD;
      const atRight = r.right >= window.innerWidth - EDGE_THRESHOLD;
      const atTop = r.top <= EDGE_THRESHOLD;
      const atBottom = r.bottom >= window.innerHeight - EDGE_THRESHOLD;

      let radius = "999px";
      if (atLeft && atTop)
        radius = "0 999px 999px 0"; // top-left corner
      else if (atRight && atTop)
        radius = "999px 0 0 999px"; // top-right corner
      else if (atLeft && atBottom)
        radius = "0 999px 999px 0"; // bottom-left corner
      else if (atRight && atBottom)
        radius = "999px 0 0 999px"; // bottom-right corner
      else if (atLeft)
        radius = "0 999px 999px 0"; // left edge
      else if (atRight)
        radius = "999px 0 0 999px"; // right edge
      else if (atTop)
        radius = "0 0 999px 999px"; // top edge
      else if (atBottom) radius = "999px 999px 0 0"; // bottom edge

      container.style.borderRadius = radius;
    };

    // Constrain position within screen bounds
    const constrainPosition = () => {
      const r = container.getBoundingClientRect();
      const currentLeft = parseInt(container.style.left) || r.left;
      const currentTop = parseInt(container.style.top) || r.top;
      const newLeft = Math.max(0, Math.min(window.innerWidth - r.width, currentLeft));
      const newTop = Math.max(0, Math.min(window.innerHeight - r.height, currentTop));

      if (newLeft !== currentLeft || newTop !== currentTop) {
        container.style.right = "auto";
        container.style.bottom = "auto";
        container.style.left = newLeft + "px";
        container.style.top = newTop + "px";
      }
      updateBorderRadius();
    };

    // Initial check
    updateVideoButtonVisibility();

    // Watch for video elements being added/removed
    videoObserver = new MutationObserver(updateVideoButtonVisibility);
    videoObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Handle window resize
    window.addEventListener("resize", constrainPosition, { signal });

    let dragging = false;
    let startX = 0,
      startY = 0,
      startLeft = 0,
      startTop = 0;

    const initDrag = (clientX, clientY) => {
      isDragged = false;
      dragging = true;
      const r = container.getBoundingClientRect();
      startX = clientX;
      startY = clientY;
      startLeft = r.left;
      startTop = r.top;
      container.style.right = "auto";
      container.style.bottom = "auto";
      container.style.left = startLeft + "px";
      container.style.top = startTop + "px";
    };
    const moveDrag = (clientX, clientY) => {
      if (!dragging) return;
      const dx = clientX - startX,
        dy = clientY - startY;
      if (!isDragged && Math.abs(dx) + Math.abs(dy) > 6) {
        isDragged = true;
        const r = container.getBoundingClientRect();
        startLeft = clientX - r.width / 2;
        startTop = clientY - r.height / 2;
        startX = clientX;
        startY = clientY;
      }
      if (isDragged) {
        const r = container.getBoundingClientRect();
        const newLeft = startLeft + (clientX - startX);
        const newTop = startTop + (clientY - startY);
        container.style.left = Math.max(0, Math.min(window.innerWidth - r.width, newLeft)) + "px";
        container.style.top = Math.max(0, Math.min(window.innerHeight - r.height, newTop)) + "px";
        updateBorderRadius();
      }
    };
    const stopDrag = () => {
      if (isDragged) {
        GM_setValue(
          "lianki_pos",
          JSON.stringify({ x: parseInt(container.style.left), y: parseInt(container.style.top) }),
        );
        updateBorderRadius();
      }
      dragging = false;
    };

    container.addEventListener(
      "touchstart",
      (e) => initDrag(e.touches[0].clientX, e.touches[0].clientY),
      { passive: true },
    );
    container.addEventListener(
      "touchmove",
      (e) => {
        if (dragging) {
          e.preventDefault();
          moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      },
      { passive: false },
    );
    container.addEventListener("touchend", stopDrag, { passive: true });
    container.addEventListener("mousedown", (e) => {
      initDrag(e.clientX, e.clientY);
      const onMove = (ev) => moveDrag(ev.clientX, ev.clientY);
      const onUp = () => {
        stopDrag();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    document.body.appendChild(container);
    // Load saved position after mount so getBoundingClientRect gives real width
    try {
      const saved = JSON.parse(GM_getValue("lianki_pos", "null"));
      if (saved) {
        const r = container.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - r.width, saved.x));
        const y = Math.max(0, Math.min(window.innerHeight - r.height, saved.y));
        container.style.right = "auto";
        container.style.bottom = "auto";
        container.style.left = x + "px";
        container.style.top = y + "px";
      } else {
        container.style.right = "12px";
        container.style.bottom = "20px";
      }
    } catch {
      container.style.right = "12px";
      container.style.bottom = "20px";
    }

    // Set initial border radius based on position
    updateBorderRadius();

    return container;
  }

  // ── Dialog ─────────────────────────────────────────────────────────────────
  function mountDialog() {
    // Create shadow host for complete CSS isolation
    const shadowHost = document.createElement("div");
    shadowHost.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";

    const shadow = shadowHost.attachShadow({ mode: "open" });

    // Add base reset styles in shadow DOM
    const styleReset = document.createElement("style");
    styleReset.textContent = `
      * { all: initial; box-sizing: border-box; }
      *:before, *:after { all: initial; box-sizing: border-box; }
      style { display: none !important; }
      :host {
        --lk-bg: #1e1e1e;
        --lk-fg: #eeeeee;
        --lk-shadow: 0 8px 32px rgba(0,0,0,0.6);
        --lk-input-bg: #222222;
        --lk-input-fg: #dddddd;
        --lk-input-border: #444444;
        --lk-muted: #aaaaaa;
        --lk-backdrop: rgba(0,0,0,0.75);
      }
      @media (prefers-color-scheme: light) {
        :host {
          --lk-bg: #ffffff;
          --lk-fg: #111111;
          --lk-shadow: 0 8px 32px rgba(0,0,0,0.15);
          --lk-input-bg: #f0f0f0;
          --lk-input-fg: #333333;
          --lk-input-border: #cccccc;
          --lk-muted: #666666;
          --lk-backdrop: rgba(0,0,0,0.5);
        }
      }
    `;
    shadow.appendChild(styleReset);

    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      background: "var(--lk-backdrop)",
      zIndex: "2147483645",
    });
    backdrop.addEventListener("click", closeDialog);

    const el = document.createElement("div");
    el.tabIndex = -1;
    Object.assign(el.style, {
      all: "initial",
      position: "fixed",
      zIndex: "2147483646",
      top: "50%",
      left: "50%",
      transform: "translate(-50%,-50%)",
      background: "var(--lk-bg)",
      color: "var(--lk-fg)",
      borderRadius: "12px",
      padding: "20px 24px",
      minWidth: "320px",
      maxWidth: "min(480px, 90vw)",
      maxHeight: "90vh",
      overflowY: "auto",
      boxShadow: "var(--lk-shadow)",
      fontFamily: "system-ui,sans-serif",
      fontSize: "14px",
      outline: "none",
      lineHeight: "1.5",
      boxSizing: "border-box",
    });

    shadow.appendChild(backdrop);
    shadow.appendChild(el);
    document.body.appendChild(shadowHost);

    el._backdrop = backdrop;
    el._shadowHost = shadowHost;
    return el;
  }

  function renderDialog() {
    if (!dialog) return;
    const { phase, options, error, message } = state;

    while (dialog.lastChild) dialog.removeChild(dialog.lastChild);

    // Add global style reset for all child elements
    const globalStyle = document.createElement("style");
    globalStyle.textContent = `
      * { font-family: system-ui, sans-serif; box-sizing: border-box; }
      div, span, button, a { all: revert; }
      button { cursor: pointer; }
    `;
    dialog.appendChild(globalStyle);

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "16px",
    });
    const titleSpan = document.createElement("span");
    Object.assign(titleSpan.style, { fontWeight: "700", fontSize: "16px" });
    titleSpan.textContent = "🔖 Lianki";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.setAttribute(
      "style",
      `${btn("transparent")};color:var(--lk-muted);font-size:20px;padding:0 6px;line-height:1`,
    );
    closeBtn.addEventListener("click", closeDialog);
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // Body
    if (phase === "adding") {
      const styleEl = document.createElement("style");
      styleEl.textContent =
        "@keyframes lk-spin{to{transform:rotate(360deg)}}" +
        ".lk-spinner{display:inline-block;width:20px;height:20px;" +
        "border:3px solid #555;border-top-color:#7eb8f7;border-radius:50%;" +
        "animation:lk-spin 0.8s linear infinite;vertical-align:middle;margin-right:8px}";
      dialog.appendChild(styleEl);

      const wrap = document.createElement("div");
      Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "10px" });
      const spinRow = document.createElement("div");
      Object.assign(spinRow.style, { fontSize: "15px", fontWeight: "600" });
      const spinner = document.createElement("span");
      spinner.className = "lk-spinner";
      spinRow.appendChild(spinner);
      spinRow.appendChild(document.createTextNode("Adding note\u2026"));
      const urlDiv = document.createElement("div");
      Object.assign(urlDiv.style, { color: "var(--lk-muted)", fontSize: "12px", wordBreak: "break-all" });
      urlDiv.textContent = normalizeUrl(location.href);
      wrap.appendChild(spinRow);
      wrap.appendChild(urlDiv);
      dialog.appendChild(wrap);
    } else if (phase === "error") {
      const errDiv = document.createElement("div");
      errDiv.style.color = "#f77";
      errDiv.textContent = `Error: ${error}`;
      dialog.appendChild(errDiv);

      const btnRow = document.createElement("div");
      Object.assign(btnRow.style, {
        display: "flex",
        gap: "8px",
        marginTop: "10px",
        flexWrap: "wrap",
      });

      const loginBtn = document.createElement("button");
      loginBtn.setAttribute("style", btn("#2a5f8f"));
      loginBtn.textContent = "Login to Lianki";
      loginBtn.addEventListener("click", () => window.open(ORIGIN, "_blank"));
      btnRow.appendChild(loginBtn);

      const tokenBtn = document.createElement("button");
      tokenBtn.setAttribute("style", btn("#3a6f3f"));
      tokenBtn.textContent = "Set API Token";
      tokenBtn.addEventListener("click", () => {
        const token = prompt(
          `Paste your Lianki API token.\n\nGenerate one at: ${ORIGIN}/list\n\n(Needed for Safari/Stay where cookies don't work)`,
        );
        if (!token) return;
        GM_setValue("lk:token", token.trim());
        closeDialog();
        openDialog(); // retry with token
      });
      btnRow.appendChild(tokenBtn);

      const copyBtn = document.createElement("button");
      copyBtn.setAttribute("style", btn("#444"));
      copyBtn.textContent = "Copy error";
      copyBtn.addEventListener("click", () => {
        const parts = [
          `Error: ${error}`,
          `Page: ${location.href}`,
          `Origin: ${ORIGIN}`,
          `Version: ${CURRENT_VERSION}`,
        ];
        if (state.errorDetails) parts.push(`\nResponse:\n${state.errorDetails}`);
        const text = parts.join("\n");
        navigator.clipboard?.writeText(text).catch(() => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        });
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy error";
        }, 2000);
      });
      btnRow.appendChild(copyBtn);
      dialog.appendChild(btnRow);
    } else if (phase === "reviewing") {
      const titleDiv = document.createElement("div");
      Object.assign(titleDiv.style, {
        marginBottom: "12px",
        wordBreak: "break-all",
        fontSize: "13px",
        opacity: ".8",
      });
      const bold = document.createElement("b");
      bold.textContent = document.title || location.href;
      titleDiv.appendChild(bold);
      dialog.appendChild(titleDiv);

      const btnRow = document.createElement("div");
      Object.assign(btnRow.style, {
        display: "flex",
        gap: "8px",
        flexWrap: "wrap",
        marginBottom: "8px",
      });
      for (const o of options) {
        const b = document.createElement("button");
        b.setAttribute("style", btn("#2a5f8f"));
        b.appendChild(document.createTextNode(o.label));
        b.appendChild(document.createElement("br"));
        const small = document.createElement("small");
        Object.assign(small.style, { opacity: ".7", fontSize: "11px" });
        small.textContent = o.due;
        b.appendChild(small);
        b.addEventListener("click", () => doReview(Number(o.rating)));
        btnRow.appendChild(b);
      }
      dialog.appendChild(btnRow);

      const deleteBtn = document.createElement("button");
      deleteBtn.setAttribute("style", btn("#7a2a2a"));
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", doDelete);
      dialog.appendChild(deleteBtn);

      const hints = document.createElement("div");
      Object.assign(hints.style, { marginTop: "14px", opacity: ".4", fontSize: "11px" });
      hints.textContent =
        "A/H=Easy \u00b7 S/J=Good \u00b7 W/K=Hard \u00b7 D/L=Again \u00b7 T/M=Delete \u00b7 Esc=Close";
      dialog.appendChild(hints);

      // Notes input
      const notesRow = document.createElement("div");
      Object.assign(notesRow.style, { marginTop: "10px", position: "relative" });

      const notesInput = document.createElement("input");
      notesInput.type = "text";
      notesInput.maxLength = 128;
      notesInput.placeholder = "Notes\u2026";
      notesInput.value = state.notes;
      notesInput.tabIndex = -1; // Don't auto-focus (preserve hotkeys)
      Object.assign(notesInput.style, {
        width: "100%",
        boxSizing: "border-box",
        background: "var(--lk-input-bg)",
        color: "var(--lk-input-fg)",
        border: "1px solid var(--lk-input-border)",
        borderRadius: "6px",
        padding: "6px 28px 6px 8px",
        fontSize: "12px",
        outline: "none",
      });

      const syncIndicator = document.createElement("span");
      Object.assign(syncIndicator.style, {
        position: "absolute",
        right: "8px",
        top: "50%",
        transform: "translateY(-50%)",
        fontSize: "13px",
        opacity: ".7",
        pointerEvents: "none",
      });
      syncIndicator.textContent = state.notesSynced ? "\u2713" : "\u22ef";

      let notesTimer = null;
      notesInput.addEventListener("input", () => {
        const val = notesInput.value.slice(0, 128);
        state.notes = val;
        state.notesSynced = false;
        syncIndicator.textContent = "\u22ef"; // ellipsis = pending
        clearTimeout(notesTimer);
        notesTimer = setTimeout(async () => {
          try {
            await saveNotes(state.noteId, val);
            state.notesSynced = true;
            syncIndicator.textContent = "\u2713"; // checkmark = synced
          } catch {
            syncIndicator.textContent = "\u2717"; // cross = error
          }
        }, 1000);
      });

      notesRow.appendChild(notesInput);
      notesRow.appendChild(syncIndicator);
      dialog.appendChild(notesRow);
    } else if (phase === "reviewed") {
      const msgDiv = document.createElement("div");
      Object.assign(msgDiv.style, { color: "#44bb44", fontSize: "15px" });
      msgDiv.textContent = message;
      dialog.appendChild(msgDiv);
    }
  }

  // ── Open / Close ───────────────────────────────────────────────────────────
  function openDialog() {
    if (dialog) return;
    dialog = mountDialog();
    state = { phase: "adding", noteId: null, options: null, error: null, message: null };
    prefetchedNextUrl = null;
    renderDialog();
    dialog.focus();

    const url = normalizeUrl(location.href);
    addNote(url, document.title)
      .then((note) => {
        state.noteId = note._id;
        state.notes = note.notes ?? "";
        state.notesSynced = true;
        // Prefetch next URL in background while user reviews this card
        getNextUrl()
          .then((data) => {
            prefetchedNextUrl = data.url;
            if (data.url) prefetchNextPage(data.url);
          })
          .catch(() => {});
        // Use options from add-card response if available (optimization)
        if (note.options) {
          return { options: note.options };
        }
        // Fallback for older API versions
        return getOptions(note._id);
      })
      .then((data) => {
        state.phase = "reviewing";
        state.options = data.options;
        renderDialog();
      })
      .catch((err) => {
        state.phase = "error";
        state.error = err.message;
        state.errorDetails = err.details ?? null;
        renderDialog();
      });
  }

  function closeDialog() {
    if (!dialog) return;
    dialog._backdrop?.remove();
    dialog._shadowHost?.remove();
    dialog.remove();
    dialog = null;
    state = { phase: "idle", noteId: null, options: null, error: null, message: null };

    // Clean up prefetch link when closing dialog
    if (prefetchLink) {
      prefetchLink.remove();
      prefetchLink = null;
    }
  }

  // ── Review actions ─────────────────────────────────────────────────────────
  async function doReview(rating) {
    if (state.phase !== "reviewing" || !state.noteId) return;
    try {
      const result = await submitReview(state.noteId, rating);
      // Use nextUrl from review response if available (optimization)
      if (result.nextUrl) {
        prefetchedNextUrl = result.nextUrl;
        prefetchNextPage(result.nextUrl);
      }
      const opt = state.options.find((o) => Number(o.rating) === rating);
      await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
      renderDialog();
    }
  }

  async function doDelete() {
    if (state.phase !== "reviewing" || !state.noteId) return;
    try {
      const result = await deleteNote(state.noteId);
      gmCacheInvalidate(noteKey(normalizeUrl(location.href)));
      // Use nextUrl from delete response if available (optimization)
      if (result.nextUrl) {
        prefetchedNextUrl = result.nextUrl;
        prefetchNextPage(result.nextUrl);
      }
      await afterReview("Deleted!");
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
      renderDialog();
    }
  }

  async function afterReview(doneMessage) {
    state.phase = "reviewed";

    // Use prefetched URL if already ready — redirect is instant, no spinner
    let nextUrl = prefetchedNextUrl;
    let nextTitle = null;
    prefetchedNextUrl = null;

    if (!nextUrl) {
      state.message = "Loading next card\u2026";
      renderDialog();
      const data = await getNextUrl().catch(() => ({ url: null, title: null }));
      nextUrl = data.url;
      nextTitle = data.title;
      if (nextUrl) {
        prefetchNextPage(nextUrl);
        state.message = `Redirecting to:\n${nextTitle || nextUrl}`;
        renderDialog();
      }
    }

    if (nextUrl && /^https?:\/\//.test(nextUrl)) {
      // Normal navigation to next card (backend already filtered hijacking domains)
      console.log("[Lianki] Storing intended URL:", nextUrl);
      GM_setValue("lk:nav_intended", JSON.stringify({ url: nextUrl, ts: Date.now() }));
      location.href = nextUrl;
    } else {
      // No more cards or invalid URL
      state.message = `${doneMessage} — All done!`;
      renderDialog();
      setTimeout(closeDialog, 2000);
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const KEYS = {
    Digit1: () => doReview(1),
    KeyD: () => doReview(1),
    KeyL: () => doReview(1),
    Digit2: () => doReview(2),
    KeyW: () => doReview(2),
    KeyK: () => doReview(2),
    Digit3: () => doReview(3),
    KeyS: () => doReview(3),
    KeyJ: () => doReview(3),
    Digit4: () => doReview(4),
    KeyA: () => doReview(4),
    KeyH: () => doReview(4),
    Digit5: () => doDelete(),
    KeyT: () => doDelete(),
    KeyM: () => doDelete(),
    Escape: () => closeDialog(),
  };

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (dialog) closeDialog();
        else openDialog();
        return;
      }
      if (!dialog || state.phase !== "reviewing") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const action = KEYS[e.code];
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        action();
      }
    },
    { capture: true, signal },
  );

  // ── Media Keys ─────────────────────────────────────────────────────────────
  // Support hardware media keys (headphones, keyboards, etc.)
  // nexttrack = faster (1.2x), previoustrack = slower + rewind (-3s, 0.7x)
  (() => {
    let vcid = null;
    document.addEventListener("visibilitychange", trackHandler, { signal });
    function trackHandler() {
      const cb = () => {
        if (!navigator.mediaSession) return;
        navigator.mediaSession.setActionHandler("nexttrack", () => {
          pardon(0, 1.2); // Faster
        });
        navigator.mediaSession.setActionHandler("previoustrack", () => {
          pardon(-3, 0.7); // Rewind 3s and slower
        });
      };
      if (document.visibilityState === "hidden") {
        vcid = void clearInterval(vcid);
      } else {
        cb();
        vcid ??= setInterval(cb, 1000);
      }
    }
    trackHandler();
  })();

  // ── Mount ──────────────────────────────────────────────────────────────────
  // Load preferences (async, non-blocking)
  loadPreferences();

  fab = createUI();

  // ── Redirect detection ─────────────────────────────────────────────────────
  // If Lianki navigated to a URL but the site auto-redirected to a different
  // one, update the card's stored URL to match the actual final location, then
  // auto-open the review dialog so the session continues uninterrupted.
  // Also handles pushState/replaceState URL changes.

  async function checkRedirect() {
    try {
      const raw = GM_getValue("lk:nav_intended", "");
      if (!raw) return;
      const { url: intendedUrl, ts } = JSON.parse(raw);
      if (Date.now() - ts > 30_000) return; // 30 s TTL — stale, ignore
      const actualUrl = location.href;
      if (normalizeUrl(actualUrl) === normalizeUrl(intendedUrl)) {
        GM_setValue("lk:nav_intended", ""); // no redirect, clear it
        return;
      }

      console.log("[Lianki] Redirect detected:", intendedUrl, "→", actualUrl);

      // Ask user if they want to update the card URL
      const confirmed = confirm(
        `This page redirected from:\n${intendedUrl}\n\n` +
          `To:\n${actualUrl}\n\n` +
          `Update the card to point to the new URL?`,
      );

      if (!confirmed) {
        console.log("[Lianki] User declined URL update");
        GM_setValue("lk:nav_intended", ""); // user declined, clear it
        return;
      }

      const result = await api("/api/fsrs/update-url", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldUrl: intendedUrl, newUrl: actualUrl }),
      });
      console.log("[Lianki] Card URL updated:", result);
      GM_setValue("lk:nav_intended", ""); // only clear after success
      openDialog();
    } catch (err) {
      console.error("[Lianki] Failed to update card URL:", err);
      // Don't clear GM_setValue - retry on next page load
    }
  }

  // Check on page load
  checkRedirect();

  // Monitor URL changes for SPA redirects
  if ("navigation" in window) {
    // Modern Navigation API (Chrome 102+, Edge 102+)
    navigation.addEventListener("navigatesuccess", () => checkRedirect(), { signal });
  } else {
    // Fallback: wrap history methods for older browsers
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      setTimeout(checkRedirect, 100);
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      setTimeout(checkRedirect, 100);
    };

    // Also listen to popstate (back/forward buttons)
    window.addEventListener("popstate", () => setTimeout(checkRedirect, 100), { signal });
  }

  // ── Video Speed Control (Pardon) ───────────────────────────────────────────
  // Press , or v (slower) / . or b (faster) to adjust video speed. Speed adjustments are
  // remembered as "difficulty markers" and auto-applied during playback.

  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const renderTime = (t) =>
    [(t / 3600) | 0, ((t / 60) | 0) % 60, (t % 60) | 0]
      .map((e) => e.toString().padStart(2, "0"))
      .join(":");
  const renderSpeed = (s) => "x" + s.toFixed(2);

  function centerTooltip(textContent) {
    const el = document.createElement("div");
    el.textContent = textContent;
    el.style.cssText =
      "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); " +
      "background: #0008; color: white; padding: 0.5rem; border-radius: 1rem; " +
      "z-index: 2147483647; pointer-events: none;";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 500);
  }

  // Speed map: WeakMap<videoElement, Map<timestamp, speed>>
  const videoSpeedMaps = new WeakMap();

  // GM_setValue cache helpers for persistent storage
  const markerCacheKey = (url) => `lk:markers:${normalizeUrl(url)}`;

  function loadLocalMarkers(url) {
    try {
      const raw = GM_getValue(markerCacheKey(url), "");
      if (!raw) return { markers: {}, lastSync: 0, dirty: false };
      return JSON.parse(raw);
    } catch {
      return { markers: {}, lastSync: 0, dirty: false };
    }
  }

  function saveLocalMarkers(url, markers, dirty = true) {
    const cache = {
      markers,
      lastSync: dirty ? loadLocalMarkers(url).lastSync : Date.now(),
      dirty,
    };
    GM_setValue(markerCacheKey(url), JSON.stringify(cache));
  }

  async function pardon(dt = 0, speedMultiplier = 1, wait = 0) {
    const vs = $$("video,audio");
    const v = vs.filter((e) => !e.paused)[0];
    if (!v) return vs[0]?.click();

    // Helper to merge nearby markers (within 2 seconds)
    const mergeNearbyMarkers = (time) => {
      if (speedMultiplier === 1) return; // Only merge when speed is being adjusted
      if (!videoSpeedMaps.has(v)) videoSpeedMaps.set(v, new Map());
      const speedMap = videoSpeedMaps.get(v);
      const MERGE_THRESHOLD = 2.0; // seconds
      for (const [existingTime] of speedMap) {
        if (Math.abs(time - existingTime) < MERGE_THRESHOLD) {
          speedMap.delete(existingTime);
          console.log(`[Lianki] Merged marker: ${renderTime(existingTime)} @ ${renderTime(time)}`);
        }
      }
    };

    // Merge at original position BEFORE time adjustment
    mergeNearbyMarkers(v.currentTime);

    if (dt !== 0) v.currentTime += dt;

    // Merge at destination position AFTER time adjustment
    mergeNearbyMarkers(v.currentTime);

    if (speedMultiplier !== 1) {
      v.playbackRate *= speedMultiplier;

      // Speed map already initialized by mergeNearbyMarkers
      const speedMap = videoSpeedMaps.get(v);

      // Add new marker at final position
      speedMap.set(v.currentTime, v.playbackRate);
      console.log(
        `[Lianki] Speed marker: ${renderTime(v.currentTime)} → ${renderSpeed(v.playbackRate)}`,
      );

      // Save to local cache (GM_setValue)
      const url = normalizeUrl(location.href);
      const markers = Object.fromEntries(speedMap);
      saveLocalMarkers(url, markers, true); // dirty = true
    }

    centerTooltip(
      (dt < 0 ? "<-" : "->") + " " + renderTime(v.currentTime) + " " + renderSpeed(v.playbackRate),
    );

    if (wait) await sleep(wait);
    return true;
  }

  // Keyboard shortcuts for video speed control
  window.addEventListener(
    "keydown",
    async (e) => {
      // Skip if Lianki dialog is open or in input fields
      if (dialog) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (document?.activeElement?.isContentEditable) return;
      if (["INPUT", "TEXTAREA"].includes(document?.activeElement?.tagName)) return;

      if (e.code === "Comma" || e.code === "KeyV") {
        if (await pardon(-3, 0.7)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      if (e.code === "Period" || e.code === "KeyB") {
        if (await pardon(0, 1.2)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    { capture: true },
  );

  // Auto-adjust speed at marked timestamps
  function setupVideoSpeedTracking(video) {
    const url = normalizeUrl(location.href);

    // Load markers from DB → GM_setValue → WeakMap
    (async () => {
      try {
        const local = loadLocalMarkers(url);

        // Always fetch from DB for cross-device sync
        const { markers } = await api(`/api/fsrs/speed-markers?url=${encodeURIComponent(url)}`);

        // Merge: server wins for conflicts, use latest
        const merged = { ...local.markers, ...markers };

        // Save to local cache
        saveLocalMarkers(url, merged, false); // not dirty, just synced

        // Load into WeakMap for this video
        if (!videoSpeedMaps.has(video)) videoSpeedMaps.set(video, new Map());
        const speedMap = videoSpeedMaps.get(video);
        for (const [timestamp, speed] of Object.entries(merged)) {
          speedMap.set(parseFloat(timestamp), speed);
        }

        console.log(`[Lianki] Loaded ${Object.keys(merged).length} speed markers for ${url}`);
      } catch (err) {
        console.error("[Lianki] Failed to load speed markers:", err);
        // Fall back to local cache
        const local = loadLocalMarkers(url);
        if (!videoSpeedMaps.has(video)) videoSpeedMaps.set(video, new Map());
        const speedMap = videoSpeedMaps.get(video);
        for (const [timestamp, speed] of Object.entries(local.markers)) {
          speedMap.set(parseFloat(timestamp), speed);
        }
      }
    })();

    let lastCheckedTime = 0;

    video.addEventListener("timeupdate", () => {
      const speedMap = videoSpeedMaps.get(video);
      if (!speedMap || speedMap.size === 0) return;

      const currentTime = video.currentTime;
      const threshold = 0.5; // 500ms window

      // Only check if we've moved significantly (avoid spam)
      if (Math.abs(currentTime - lastCheckedTime) < 0.3) return;
      lastCheckedTime = currentTime;

      // Find nearest marker
      for (const [markedTime, targetSpeed] of speedMap) {
        if (Math.abs(currentTime - markedTime) < threshold) {
          if (Math.abs(video.playbackRate - targetSpeed) > 0.01) {
            video.playbackRate = targetSpeed;
            centerTooltip(`Auto-speed: ${renderSpeed(targetSpeed)} @ ${renderTime(markedTime)}`);
            console.log(
              `[Lianki] Auto-adjusted to ${renderSpeed(targetSpeed)} at ${renderTime(currentTime)}`,
            );
          }
          break; // Only apply one marker per check
        }
      }
    });
  }

  // Detect and track all video/audio elements
  function observeVideos() {
    const tracked = new WeakSet();

    const trackVideo = (v) => {
      if (tracked.has(v)) return;
      tracked.add(v);
      setupVideoSpeedTracking(v);
    };

    // Track existing videos
    $$("video,audio").forEach(trackVideo);

    // Track future videos
    const observer = new MutationObserver(() => {
      $$("video,audio").forEach(trackVideo);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  observeVideos();

  // Periodic sync to DB (every 30s)
  setInterval(async () => {
    try {
      const url = normalizeUrl(location.href);
      const cache = loadLocalMarkers(url);

      if (!cache.dirty) return; // No changes to sync

      console.log(`[Lianki] Syncing ${Object.keys(cache.markers).length} markers to DB...`);

      await api("/api/fsrs/speed-markers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, markers: cache.markers }),
      });

      // Mark as synced
      saveLocalMarkers(url, cache.markers, false); // dirty = false
      console.log("[Lianki] Sync complete");
    } catch (err) {
      console.error("[Lianki] Sync failed:", err);
      // Keep dirty flag, will retry in 30s
    }
  }, 30_000); // 30 seconds

  // ── Cleanup ────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // Offline-First Integration
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Offline-First Integration for lianki.user.js
   *
   * This code is inserted into main() to wire up offline functionality.
   * It modifies openDialog() and doReview() to use GM_setValue cache.
   */

  // ── Offline Storage Initialization ──────────────────────────────────────────
  let offlineReady = false;
  let cardStorage, configStorage, queueStorage, localFSRS;
  const deviceId = getOrCreateDeviceId();
  let syncInProgress = false;
  let syncTimer = null;

  // Initialize offline storage (GM_setValue is synchronous — always ready)
  function initOfflineStorage() {
    try {
      cardStorage = new GMCardStorage();
      configStorage = new GMConfigStorage();
      queueStorage = new GMQueueStorage();

      // Load FSRS parameters
      const config = configStorage.getConfig();
      localFSRS = new LocalFSRS(config.fsrsParams);

      offlineReady = true;
      console.log("[Lianki] Offline storage initialized");

      // Start background sync loop
      startBackgroundSync();

      // Prefetch due cards in background
      setTimeout(() => prefetchDueCards(), 2000);
    } catch (err) {
      console.error("[Lianki] Failed to initialize offline storage:", err);
      // Graceful degradation - continue with online-only mode
    }
  }

  // ── Modified openDialog (Offline-First) ─────────────────────────────────────
  const _originalOpenDialog = openDialog;
  openDialog = async function openDialogOffline() {
    if (dialog) return;

    dialog = mountDialog();
    state = { phase: "adding", noteId: null, options: null, error: null, message: null };
    prefetchedNextUrl = null;
    renderDialog();
    dialog.focus();

    const url = normalizeUrl(location.href);

    // Offline-first: Check GM cache
    if (offlineReady) {
      try {
        const cachedCard = cardStorage.getCard(url);

        if (cachedCard) {
          console.log("[Lianki] Using cached card");

          // Instant review from cache!
          state.noteId = cachedCard.note._id;
          state.notes = cachedCard.note.notes ?? "";
          state.notesSynced = !cachedCard.dirty;
          state.phase = "reviewing";
          state.options = localFSRS.calculateOptions(cachedCard.note.card);
          renderDialog();

          // Background: Ensure server has latest (if online)
          if (navigator.onLine && cachedCard.dirty) {
            queueStorage.addToQueue("sync", { url }, cachedCard.hlc);
            tryBackgroundSync();
          }

          // Background: Prefetch next card
          setTimeout(() => prefetchNextCachedCard(), 100);

          return;
        }
      } catch (err) {
        console.error("[Lianki] Cache check failed:", err);
        // Fall through to online mode
      }
    }

    // Fallback: Original online behavior
    addNote(url, document.title)
      .then(async (note) => {
        state.noteId = note._id;
        state.notes = note.notes ?? "";
        state.notesSynced = true;

        // Save to cache
        if (offlineReady) {
          try {
            cardStorage.setCard(url, note, null);
          } catch (err) {
            console.error("[Lianki] Failed to cache card:", err);
          }
        }

        // Prefetch next URL in background while user reviews this card
        getNextUrl()
          .then((data) => {
            prefetchedNextUrl = data.url;
            if (data.url) prefetchNextPage(data.url);
          })
          .catch(() => {});

        // Use options from add-card response if available (optimization)
        if (note.options) {
          return { options: note.options };
        }

        // Or calculate locally if we have FSRS params
        if (offlineReady && localFSRS) {
          return { options: localFSRS.calculateOptions(note.card) };
        }

        // Fallback for older API versions
        return getOptions(note._id);
      })
      .then((data) => {
        state.phase = "reviewing";
        state.options = data.options;
        renderDialog();
      })
      .catch((err) => {
        // Guest mode: 401 → create local-only card
        if (
          offlineReady &&
          (err?.status === 401 ||
            String(err?.message).includes("401") ||
            String(err?.message).toLowerCase().includes("unauthorized"))
        ) {
          const localNote = {
            _id: "local:" + hashUrl(url),
            url,
            title: document.title,
            card: localFSRS.newCard(),
            notes: "",
            hlc: newHLC(deviceId, null),
          };
          cardStorage.setCard(url, localNote, localNote.hlc, true);
          queueStorage.addToQueue("add", { url, title: document.title }, localNote.hlc);
          state.noteId = localNote._id;
          state.notes = "";
          state.notesSynced = false;
          state.phase = "reviewing";
          state.options = localFSRS.calculateOptions(localNote.card);
          renderDialog();
          return;
        }
        state.phase = "error";
        state.error = err.message;
        state.errorDetails = err.details ?? null;
        renderDialog();
      });
  };

  // ── Modified doReview (Offline-First) ───────────────────────────────────────
  const _originalDoReview = doReview;
  doReview = async function doReviewOffline(rating) {
    if (state.phase !== "reviewing" || !state.noteId) return;

    const url = normalizeUrl(location.href);

    // Offline-first: Update locally
    if (offlineReady) {
      try {
        const cachedCard = cardStorage.getCard(url);

        if (cachedCard && localFSRS) {
          console.log("[Lianki] Applying review locally");

          // Apply review with ts-fsrs
          const reviewResult = localFSRS.applyReview(cachedCard.note.card, rating);

          // Update card
          cachedCard.note.card = reviewResult.card;
          cachedCard.note.log = cachedCard.note.log || [];
          cachedCard.note.log.push(reviewResult.log);

          // Update HLC
          const newHlc = newHLC(deviceId, cachedCard.hlc);
          cardStorage.setCard(url, cachedCard.note, newHlc, true); // dirty = true

          // Queue for server sync
          queueStorage.addToQueue(
            "review",
            {
              url,
              noteId: state.noteId,
              rating,
            },
            newHlc,
          );

          // Instant feedback!
          const opt = state.options.find((o) => Number(o.rating) === rating);
          await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);

          // Background sync
          tryBackgroundSync();

          return;
        }
      } catch (err) {
        console.error("[Lianki] Local review failed:", err);
        // Fall through to online mode
      }
    }

    // Fallback: Original online behavior
    try {
      const result = await submitReview(state.noteId, rating);

      // Update cache if available
      if (offlineReady && result.card) {
        try {
          const cachedCard = cardStorage.getCard(url);
          if (cachedCard) {
            cachedCard.note.card = result.card;
            cachedCard.note.log = result.log || cachedCard.note.log;
            cardStorage.setCard(url, cachedCard.note, result.hlc);
          }
        } catch (err) {
          console.error("[Lianki] Failed to update cache:", err);
        }
      }

      // Use nextUrl from review response if available (optimization)
      if (result.nextUrl) {
        prefetchedNextUrl = result.nextUrl;
        prefetchNextPage(result.nextUrl);
      }

      const opt = state.options.find((o) => Number(o.rating) === rating);
      await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
      renderDialog();
    }
  };

  // ── Background Sync ──────────────────────────────────────────────────────────
  function startBackgroundSync() {
    // Sync every 30 seconds
    syncTimer = setInterval(() => {
      if (navigator.onLine && !syncInProgress) {
        tryBackgroundSync();
      }
    }, 30000);

    // Sync when coming online
    window.addEventListener("online", () => {
      console.log("[Lianki] Network online - starting sync");
      tryBackgroundSync();
    });

    // Initial sync
    setTimeout(() => tryBackgroundSync(), 5000);
  }

  async function tryBackgroundSync() {
    if (syncInProgress || !offlineReady) return;
    if (!navigator.onLine) {
      console.log("[Lianki] Offline - will sync when online");
      return;
    }

    syncInProgress = true;

    try {
      const queue = queueStorage.getQueue();

      if (queue.length === 0) {
        syncInProgress = false;
        return;
      }

      console.log(`[Lianki] Syncing ${queue.length} pending updates...`);

      // Sync in order (HLC sorted)
      for (const item of queue) {
        try {
          await syncQueueItem(item);
          queueStorage.removeFromQueue(item.id);
          console.log(`[Lianki] Synced: ${item.action} ${item.data.url || item.data.noteId}`);
        } catch (err) {
          console.error(`[Lianki] Sync failed for ${item.id}:`, err);

          // Increment retry count
          item.retries = (item.retries || 0) + 1;

          if (item.retries > 5) {
            console.warn(`[Lianki] Dropping ${item.id} after 5 retries`);
            queueStorage.removeFromQueue(item.id);
          } else {
            queueStorage.updateQueueItem(item.id, { retries: item.retries });
          }
        }
      }

      // Update last sync time
      configStorage.updateLastSync(newHLC(deviceId, null));

      console.log("[Lianki] Sync complete");
    } finally {
      syncInProgress = false;
    }
  }

  async function syncQueueItem(item) {
    switch (item.action) {
      case "review":
        await api(
          `/api/fsrs/review/${item.data.rating}/?id=${encodeURIComponent(item.data.noteId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hlc: item.hlc }),
          },
        );
        break;

      case "add":
        await addNote(item.data.url, item.data.title);
        break;

      case "delete":
        await deleteNote(item.data.noteId);
        break;

      case "sync":
        // Just verify card is on server
        await api(`/api/fsrs/get?url=${encodeURIComponent(item.data.url)}`);
        break;
    }
  }

  // ── Prefetch Due Cards ───────────────────────────────────────────────────────
  async function prefetchDueCards() {
    if (!offlineReady || !navigator.onLine) return;

    try {
      console.log("[Lianki] Prefetching due cards...");

      const response = await api("/api/fsrs/due?limit=20");
      const dueCards = response.cards || [];

      for (const note of dueCards) {
        try {
          const url = note.url;
          const existing = cardStorage.getCard(url);

          // Update if server version is newer or doesn't exist
          if (!existing || compareHLC(note.hlc, existing.hlc) > 0) {
            cardStorage.setCard(
              url,
              note,
              note.hlc || newHLC("server", null),
              false, // not dirty
            );
          }
        } catch (err) {
          console.error(`[Lianki] Failed to cache card ${note.url}:`, err);
        }
      }

      console.log(`[Lianki] Prefetched ${dueCards.length} cards`);
    } catch (err) {
      console.error("[Lianki] Prefetch failed:", err);
    }
  }

  async function prefetchNextCachedCard() {
    if (!offlineReady) return;

    try {
      const dueCards = cardStorage.getDueCards(1);
      if (dueCards.length > 0 && dueCards[0].url !== location.href) {
        prefetchNextPage(dueCards[0].url);
      }
    } catch (err) {
      console.error("[Lianki] Failed to prefetch next cached card:", err);
    }
  }

  // ── Render Sync Status ───────────────────────────────────────────────────────
  const _originalRenderDialog = renderDialog;
  renderDialog = function renderDialogWithSync() {
    _originalRenderDialog();

    // Add sync status indicator
    if (dialog && offlineReady) {
      const indicator = document.createElement("div");
      Object.assign(indicator.style, {
        position: "absolute",
        top: "8px",
        right: "8px",
        fontSize: "11px",
        opacity: "0.6",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      });

      (() => {
        const queue = queueStorage.getQueue();
        const queueCount = queue.length;

        if (!navigator.onLine) {
          indicator.textContent = "📴 Offline";
        } else if (syncInProgress) {
          indicator.textContent = "🔄 Syncing...";
        } else if (queueCount > 0) {
          indicator.textContent = `⏳ ${queueCount}`;
        } else {
          indicator.textContent = "✓";
        }

        dialog.appendChild(indicator);
      })();
    }
  };

  // ── Initialize on startup ────────────────────────────────────────────────────
  // GM_setValue is synchronous — call directly after api() is defined
  setTimeout(() => {
    initOfflineStorage();
  }, 100);

  return () => {
    ac.abort();
    closeDialog();
    videoObserver?.disconnect();
    fab?.remove();
    fab = null;
  };
}
