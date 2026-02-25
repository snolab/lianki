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
})();
