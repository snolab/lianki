// ==UserScript==
// @name        Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_info
// @version     2.21.5
// @author      lianki.com
// @description Lianki spaced repetition — offline-first with IndexedDB sync. Press , or . (or media keys) to control video speed with difficulty markers.
// @run-at      document-end
// @downloadURL https://www.lianki.com/lianki.user.js
// @updateURL   https://www.lianki.com/lianki.meta.js
// @connect     lianki.com
// @connect     www.lianki.com
// @connect     beta.lianki.com
// ==/UserScript==
(() => {

  // node_modules/ts-fsrs/dist/index.mjs
  var State = /* @__PURE__ */ ((State2) => {
    State2[State2["New"] = 0] = "New";
    State2[State2["Learning"] = 1] = "Learning";
    State2[State2["Review"] = 2] = "Review";
    State2[State2["Relearning"] = 3] = "Relearning";
    return State2;
  })(State || {});
  var Rating = /* @__PURE__ */ ((Rating2) => {
    Rating2[Rating2["Manual"] = 0] = "Manual";
    Rating2[Rating2["Again"] = 1] = "Again";
    Rating2[Rating2["Hard"] = 2] = "Hard";
    Rating2[Rating2["Good"] = 3] = "Good";
    Rating2[Rating2["Easy"] = 4] = "Easy";
    return Rating2;
  })(Rating || {});

  class TypeConvert {
    static card(card) {
      return {
        ...card,
        state: TypeConvert.state(card.state),
        due: TypeConvert.time(card.due),
        last_review: card.last_review ? TypeConvert.time(card.last_review) : undefined
      };
    }
    static rating(value) {
      if (typeof value === "string") {
        const firstLetter = value.charAt(0).toUpperCase();
        const restOfString = value.slice(1).toLowerCase();
        const ret = Rating[`${firstLetter}${restOfString}`];
        if (ret === undefined) {
          throw new Error(`Invalid rating:[${value}]`);
        }
        return ret;
      } else if (typeof value === "number") {
        return value;
      }
      throw new Error(`Invalid rating:[${value}]`);
    }
    static state(value) {
      if (typeof value === "string") {
        const firstLetter = value.charAt(0).toUpperCase();
        const restOfString = value.slice(1).toLowerCase();
        const ret = State[`${firstLetter}${restOfString}`];
        if (ret === undefined) {
          throw new Error(`Invalid state:[${value}]`);
        }
        return ret;
      } else if (typeof value === "number") {
        return value;
      }
      throw new Error(`Invalid state:[${value}]`);
    }
    static time(value) {
      const date = new Date(value);
      if (typeof value === "object" && value !== null && !Number.isNaN(Date.parse(value) || +date)) {
        return date;
      } else if (typeof value === "string") {
        const timestamp = Date.parse(value);
        if (!Number.isNaN(timestamp)) {
          return new Date(timestamp);
        } else {
          throw new Error(`Invalid date:[${value}]`);
        }
      } else if (typeof value === "number") {
        return new Date(value);
      }
      throw new Error(`Invalid date:[${value}]`);
    }
    static review_log(log) {
      return {
        ...log,
        due: TypeConvert.time(log.due),
        rating: TypeConvert.rating(log.rating),
        state: TypeConvert.state(log.state),
        review: TypeConvert.time(log.review)
      };
    }
  }
  Date.prototype.scheduler = function(t, isDay) {
    return date_scheduler(this, t, isDay);
  };
  Date.prototype.diff = function(pre, unit) {
    return date_diff(this, pre, unit);
  };
  Date.prototype.format = function() {
    return formatDate(this);
  };
  Date.prototype.dueFormat = function(last_review, unit, timeUnit) {
    return show_diff_message(this, last_review, unit, timeUnit);
  };
  function date_scheduler(now, t, isDay) {
    return new Date(isDay ? TypeConvert.time(now).getTime() + t * 24 * 60 * 60 * 1000 : TypeConvert.time(now).getTime() + t * 60 * 1000);
  }
  function date_diff(now, pre, unit) {
    if (!now || !pre) {
      throw new Error("Invalid date");
    }
    const diff = TypeConvert.time(now).getTime() - TypeConvert.time(pre).getTime();
    let r = 0;
    switch (unit) {
      case "days":
        r = Math.floor(diff / (24 * 60 * 60 * 1000));
        break;
      case "minutes":
        r = Math.floor(diff / (60 * 1000));
        break;
    }
    return r;
  }
  function formatDate(dateInput) {
    const date = TypeConvert.time(dateInput);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    return `${year}-${padZero(month)}-${padZero(day)} ${padZero(hours)}:${padZero(minutes)}:${padZero(seconds)}`;
  }
  function padZero(num) {
    return num < 10 ? `0${num}` : `${num}`;
  }
  var TIMEUNIT = [60, 60, 24, 31, 12];
  var TIMEUNITFORMAT = ["second", "min", "hour", "day", "month", "year"];
  function show_diff_message(due, last_review, unit, timeUnit = TIMEUNITFORMAT) {
    due = TypeConvert.time(due);
    last_review = TypeConvert.time(last_review);
    if (timeUnit.length !== TIMEUNITFORMAT.length) {
      timeUnit = TIMEUNITFORMAT;
    }
    let diff = due.getTime() - last_review.getTime();
    let i = 0;
    diff /= 1000;
    for (i = 0;i < TIMEUNIT.length; i++) {
      if (diff < TIMEUNIT[i]) {
        break;
      } else {
        diff /= TIMEUNIT[i];
      }
    }
    return `${Math.floor(diff)}${unit ? timeUnit[i] : ""}`;
  }
  var Grades = Object.freeze([
    Rating.Again,
    Rating.Hard,
    Rating.Good,
    Rating.Easy
  ]);
  var FUZZ_RANGES = [
    {
      start: 2.5,
      end: 7,
      factor: 0.15
    },
    {
      start: 7,
      end: 20,
      factor: 0.1
    },
    {
      start: 20,
      end: Infinity,
      factor: 0.05
    }
  ];
  function get_fuzz_range(interval, elapsed_days, maximum_interval) {
    let delta = 1;
    for (const range of FUZZ_RANGES) {
      delta += range.factor * Math.max(Math.min(interval, range.end) - range.start, 0);
    }
    interval = Math.min(interval, maximum_interval);
    let min_ivl = Math.max(2, Math.round(interval - delta));
    const max_ivl = Math.min(Math.round(interval + delta), maximum_interval);
    if (interval > elapsed_days) {
      min_ivl = Math.max(min_ivl, elapsed_days + 1);
    }
    min_ivl = Math.min(min_ivl, max_ivl);
    return { min_ivl, max_ivl };
  }
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function dateDiffInDays(last, cur) {
    const utc1 = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
    const utc2 = Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate());
    return Math.floor((utc2 - utc1) / 86400000);
  }
  var ConvertStepUnitToMinutes = (step) => {
    const unit = step.slice(-1);
    const value = parseInt(step.slice(0, -1), 10);
    if (Number.isNaN(value) || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid step value: ${step}`);
    }
    switch (unit) {
      case "m":
        return value;
      case "h":
        return value * 60;
      case "d":
        return value * 1440;
      default:
        throw new Error(`Invalid step unit: ${step}, expected m/h/d`);
    }
  };
  var BasicLearningStepsStrategy = (params, state, cur_step) => {
    const learning_steps = state === State.Relearning || state === State.Review ? params.relearning_steps : params.learning_steps;
    const steps_length = learning_steps.length;
    if (steps_length === 0 || cur_step >= steps_length)
      return {};
    const firstStep = learning_steps[0];
    const toMinutes = ConvertStepUnitToMinutes;
    const getAgainInterval = () => {
      return toMinutes(firstStep);
    };
    const getHardInterval = () => {
      if (steps_length === 1)
        return Math.round(toMinutes(firstStep) * 1.5);
      const nextStep = learning_steps[1];
      return Math.round((toMinutes(firstStep) + toMinutes(nextStep)) / 2);
    };
    const getStepInfo = (index) => {
      if (index < 0 || index >= steps_length) {
        return null;
      } else {
        return learning_steps[index];
      }
    };
    const getGoodMinutes = (step) => {
      return toMinutes(step);
    };
    const result = {};
    const step_info = getStepInfo(Math.max(0, cur_step));
    if (state === State.Review) {
      result[Rating.Again] = {
        scheduled_minutes: toMinutes(step_info),
        next_step: 0
      };
      return result;
    } else {
      result[Rating.Again] = {
        scheduled_minutes: getAgainInterval(),
        next_step: 0
      };
      result[Rating.Hard] = {
        scheduled_minutes: getHardInterval(),
        next_step: cur_step
      };
      const next_info = getStepInfo(cur_step + 1);
      if (next_info) {
        const nextMin = getGoodMinutes(next_info);
        if (nextMin) {
          result[Rating.Good] = {
            scheduled_minutes: Math.round(nextMin),
            next_step: cur_step + 1
          };
        }
      }
    }
    return result;
  };
  function DefaultInitSeedStrategy() {
    const time = this.review_time.getTime();
    const reps = this.current.reps;
    const mul = this.current.difficulty * this.current.stability;
    return `${time}_${reps}_${mul}`;
  }
  var StrategyMode = /* @__PURE__ */ ((StrategyMode2) => {
    StrategyMode2["SCHEDULER"] = "Scheduler";
    StrategyMode2["LEARNING_STEPS"] = "LearningSteps";
    StrategyMode2["SEED"] = "Seed";
    return StrategyMode2;
  })(StrategyMode || {});

  class AbstractScheduler {
    last;
    current;
    review_time;
    next = /* @__PURE__ */ new Map;
    algorithm;
    strategies;
    elapsed_days = 0;
    constructor(card, now, algorithm, strategies) {
      this.algorithm = algorithm;
      this.last = TypeConvert.card(card);
      this.current = TypeConvert.card(card);
      this.review_time = TypeConvert.time(now);
      this.strategies = strategies;
      this.init();
    }
    checkGrade(grade) {
      if (!Number.isFinite(grade) || grade < 0 || grade > 4) {
        throw new Error(`Invalid grade "${grade}",expected 1-4`);
      }
    }
    init() {
      const { state, last_review } = this.current;
      let interval = 0;
      if (state !== State.New && last_review) {
        interval = dateDiffInDays(last_review, this.review_time);
      }
      this.current.last_review = this.review_time;
      this.elapsed_days = interval;
      this.current.elapsed_days = interval;
      this.current.reps += 1;
      let seed_strategy = DefaultInitSeedStrategy;
      if (this.strategies) {
        const custom_strategy = this.strategies.get(StrategyMode.SEED);
        if (custom_strategy) {
          seed_strategy = custom_strategy;
        }
      }
      this.algorithm.seed = seed_strategy.call(this);
    }
    preview() {
      return {
        [Rating.Again]: this.review(Rating.Again),
        [Rating.Hard]: this.review(Rating.Hard),
        [Rating.Good]: this.review(Rating.Good),
        [Rating.Easy]: this.review(Rating.Easy),
        [Symbol.iterator]: this.previewIterator.bind(this)
      };
    }
    *previewIterator() {
      for (const grade of Grades) {
        yield this.review(grade);
      }
    }
    review(grade) {
      const { state } = this.last;
      let item;
      this.checkGrade(grade);
      switch (state) {
        case State.New:
          item = this.newState(grade);
          break;
        case State.Learning:
        case State.Relearning:
          item = this.learningState(grade);
          break;
        case State.Review:
          item = this.reviewState(grade);
          break;
      }
      return item;
    }
    buildLog(rating) {
      const { last_review, due, elapsed_days } = this.last;
      return {
        rating,
        state: this.current.state,
        due: last_review || due,
        stability: this.current.stability,
        difficulty: this.current.difficulty,
        elapsed_days: this.elapsed_days,
        last_elapsed_days: elapsed_days,
        scheduled_days: this.current.scheduled_days,
        learning_steps: this.current.learning_steps,
        review: this.review_time
      };
    }
  }

  class Alea {
    c;
    s0;
    s1;
    s2;
    constructor(seed) {
      const mash = Mash();
      this.c = 1;
      this.s0 = mash(" ");
      this.s1 = mash(" ");
      this.s2 = mash(" ");
      if (seed == null)
        seed = Date.now();
      this.s0 -= mash(seed);
      if (this.s0 < 0)
        this.s0 += 1;
      this.s1 -= mash(seed);
      if (this.s1 < 0)
        this.s1 += 1;
      this.s2 -= mash(seed);
      if (this.s2 < 0)
        this.s2 += 1;
    }
    next() {
      const t = 2091639 * this.s0 + this.c * 0.00000000023283064365386963;
      this.s0 = this.s1;
      this.s1 = this.s2;
      this.c = t | 0;
      this.s2 = t - this.c;
      return this.s2;
    }
    set state(state) {
      this.c = state.c;
      this.s0 = state.s0;
      this.s1 = state.s1;
      this.s2 = state.s2;
    }
    get state() {
      return {
        c: this.c,
        s0: this.s0,
        s1: this.s1,
        s2: this.s2
      };
    }
  }
  function Mash() {
    let n = 4022871197;
    return function mash(data) {
      data = String(data);
      for (let i = 0;i < data.length; i++) {
        n += data.charCodeAt(i);
        let h = 0.02519603282416938 * n;
        n = h >>> 0;
        h -= n;
        h *= n;
        n = h >>> 0;
        h -= n;
        n += h * 4294967296;
      }
      return (n >>> 0) * 0.00000000023283064365386963;
    };
  }
  function alea(seed) {
    const xg = new Alea(seed);
    const prng = () => xg.next();
    prng.int32 = () => xg.next() * 4294967296 | 0;
    prng.double = () => prng() + (prng() * 2097152 | 0) * 0.00000000000000011102230246251565;
    prng.state = () => xg.state;
    prng.importState = (state) => {
      xg.state = state;
      return prng;
    };
    return prng;
  }
  var version = "5.2.3";
  var default_request_retention = 0.9;
  var default_maximum_interval = 36500;
  var default_enable_fuzz = false;
  var default_enable_short_term = true;
  var default_learning_steps = Object.freeze([
    "1m",
    "10m"
  ]);
  var default_relearning_steps = Object.freeze([
    "10m"
  ]);
  var FSRSVersion = `v${version} using FSRS-6.0`;
  var S_MIN = 0.001;
  var INIT_S_MAX = 100;
  var FSRS5_DEFAULT_DECAY = 0.5;
  var FSRS6_DEFAULT_DECAY = 0.1542;
  var default_w = Object.freeze([
    0.212,
    1.2931,
    2.3065,
    8.2956,
    6.4133,
    0.8334,
    3.0194,
    0.001,
    1.8722,
    0.1666,
    0.796,
    1.4835,
    0.0614,
    0.2629,
    1.6483,
    0.6014,
    1.8729,
    0.5425,
    0.0912,
    0.0658,
    FSRS6_DEFAULT_DECAY
  ]);
  var W17_W18_Ceiling = 2;
  var CLAMP_PARAMETERS = (w17_w18_ceiling, enable_short_term = default_enable_short_term) => [
    [S_MIN, INIT_S_MAX],
    [S_MIN, INIT_S_MAX],
    [S_MIN, INIT_S_MAX],
    [S_MIN, INIT_S_MAX],
    [1, 10],
    [0.001, 4],
    [0.001, 4],
    [0.001, 0.75],
    [0, 4.5],
    [0, 0.8],
    [0.001, 3.5],
    [0.001, 5],
    [0.001, 0.25],
    [0.001, 0.9],
    [0, 4],
    [0, 1],
    [1, 6],
    [0, w17_w18_ceiling],
    [0, w17_w18_ceiling],
    [
      enable_short_term ? 0.01 : 0,
      0.8
    ],
    [0.1, 0.8]
  ];
  var clipParameters = (parameters, numRelearningSteps, enableShortTerm = default_enable_short_term) => {
    let w17_w18_ceiling = W17_W18_Ceiling;
    if (Math.max(0, numRelearningSteps) > 1) {
      const value = -(Math.log(parameters[11]) + Math.log(Math.pow(2, parameters[13]) - 1) + parameters[14] * 0.3) / numRelearningSteps;
      w17_w18_ceiling = clamp(+value.toFixed(8), 0.01, 2);
    }
    const clip = CLAMP_PARAMETERS(w17_w18_ceiling, enableShortTerm).slice(0, parameters.length);
    return clip.map(([min, max], index) => clamp(parameters[index] || 0, min, max));
  };
  var migrateParameters = (parameters, numRelearningSteps = 0, enableShortTerm = default_enable_short_term) => {
    if (parameters === undefined) {
      return [...default_w];
    }
    switch (parameters.length) {
      case 21:
        return clipParameters(Array.from(parameters), numRelearningSteps, enableShortTerm);
      case 19:
        console.debug("[FSRS-6]auto fill w from 19 to 21 length");
        return clipParameters(Array.from(parameters), numRelearningSteps, enableShortTerm).concat([0, FSRS5_DEFAULT_DECAY]);
      case 17: {
        const w = clipParameters(Array.from(parameters), numRelearningSteps, enableShortTerm);
        w[4] = +(w[5] * 2 + w[4]).toFixed(8);
        w[5] = +(Math.log(w[5] * 3 + 1) / 3).toFixed(8);
        w[6] = +(w[6] + 0.5).toFixed(8);
        console.debug("[FSRS-6]auto fill w from 17 to 21 length");
        return w.concat([0, 0, 0, FSRS5_DEFAULT_DECAY]);
      }
      default:
        console.warn("[FSRS]Invalid parameters length, using default parameters");
        return [...default_w];
    }
  };
  var generatorParameters = (props) => {
    const learning_steps = Array.isArray(props?.learning_steps) ? props.learning_steps : default_learning_steps;
    const relearning_steps = Array.isArray(props?.relearning_steps) ? props.relearning_steps : default_relearning_steps;
    const enable_short_term = props?.enable_short_term ?? default_enable_short_term;
    const w = migrateParameters(props?.w, relearning_steps.length, enable_short_term);
    return {
      request_retention: props?.request_retention || default_request_retention,
      maximum_interval: props?.maximum_interval || default_maximum_interval,
      w,
      enable_fuzz: props?.enable_fuzz ?? default_enable_fuzz,
      enable_short_term,
      learning_steps,
      relearning_steps
    };
  };
  function createEmptyCard(now, afterHandler) {
    const emptyCard = {
      due: now ? TypeConvert.time(now) : /* @__PURE__ */ new Date,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      learning_steps: 0,
      state: State.New,
      last_review: undefined
    };
    if (afterHandler && typeof afterHandler === "function") {
      return afterHandler(emptyCard);
    } else {
      return emptyCard;
    }
  }
  var computeDecayFactor = (decayOrParams) => {
    const decay = typeof decayOrParams === "number" ? -decayOrParams : -decayOrParams[20];
    const factor = Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1;
    return { decay, factor: +factor.toFixed(8) };
  };
  function forgetting_curve(decayOrParams, elapsed_days, stability) {
    const { decay, factor } = computeDecayFactor(decayOrParams);
    return +Math.pow(1 + factor * elapsed_days / stability, decay).toFixed(8);
  }

  class FSRSAlgorithm {
    param;
    intervalModifier;
    _seed;
    constructor(params) {
      this.param = new Proxy(generatorParameters(params), this.params_handler_proxy());
      this.intervalModifier = this.calculate_interval_modifier(this.param.request_retention);
      this.forgetting_curve = forgetting_curve.bind(this, this.param.w);
    }
    get interval_modifier() {
      return this.intervalModifier;
    }
    set seed(seed) {
      this._seed = seed;
    }
    calculate_interval_modifier(request_retention) {
      if (request_retention <= 0 || request_retention > 1) {
        throw new Error("Requested retention rate should be in the range (0,1]");
      }
      const { decay, factor } = computeDecayFactor(this.param.w);
      return +((Math.pow(request_retention, 1 / decay) - 1) / factor).toFixed(8);
    }
    get parameters() {
      return this.param;
    }
    set parameters(params) {
      this.update_parameters(params);
    }
    params_handler_proxy() {
      const _this = this;
      return {
        set: function(target, prop, value) {
          if (prop === "request_retention" && Number.isFinite(value)) {
            _this.intervalModifier = _this.calculate_interval_modifier(Number(value));
          } else if (prop === "w") {
            value = migrateParameters(value, target.relearning_steps.length, target.enable_short_term);
            _this.forgetting_curve = forgetting_curve.bind(this, value);
            _this.intervalModifier = _this.calculate_interval_modifier(Number(target.request_retention));
          }
          Reflect.set(target, prop, value);
          return true;
        }
      };
    }
    update_parameters(params) {
      const _params = generatorParameters(params);
      for (const key in _params) {
        const paramKey = key;
        this.param[paramKey] = _params[paramKey];
      }
    }
    init_stability(g) {
      return Math.max(this.param.w[g - 1], 0.1);
    }
    init_difficulty(g) {
      const d = this.param.w[4] - Math.exp((g - 1) * this.param.w[5]) + 1;
      return +d.toFixed(8);
    }
    apply_fuzz(ivl, elapsed_days) {
      if (!this.param.enable_fuzz || ivl < 2.5)
        return Math.round(ivl);
      const generator = alea(this._seed);
      const fuzz_factor = generator();
      const { min_ivl, max_ivl } = get_fuzz_range(ivl, elapsed_days, this.param.maximum_interval);
      return Math.floor(fuzz_factor * (max_ivl - min_ivl + 1) + min_ivl);
    }
    next_interval(s, elapsed_days) {
      const newInterval = Math.min(Math.max(1, Math.round(s * this.intervalModifier)), this.param.maximum_interval);
      return this.apply_fuzz(newInterval, elapsed_days);
    }
    linear_damping(delta_d, old_d) {
      return +(delta_d * (10 - old_d) / 9).toFixed(8);
    }
    next_difficulty(d, g) {
      const delta_d = -this.param.w[6] * (g - 3);
      const next_d = d + this.linear_damping(delta_d, d);
      return clamp(this.mean_reversion(this.init_difficulty(Rating.Easy), next_d), 1, 10);
    }
    mean_reversion(init, current) {
      return +(this.param.w[7] * init + (1 - this.param.w[7]) * current).toFixed(8);
    }
    next_recall_stability(d, s, r, g) {
      const hard_penalty = Rating.Hard === g ? this.param.w[15] : 1;
      const easy_bound = Rating.Easy === g ? this.param.w[16] : 1;
      return +clamp(s * (1 + Math.exp(this.param.w[8]) * (11 - d) * Math.pow(s, -this.param.w[9]) * (Math.exp((1 - r) * this.param.w[10]) - 1) * hard_penalty * easy_bound), S_MIN, 36500).toFixed(8);
    }
    next_forget_stability(d, s, r) {
      return +clamp(this.param.w[11] * Math.pow(d, -this.param.w[12]) * (Math.pow(s + 1, this.param.w[13]) - 1) * Math.exp((1 - r) * this.param.w[14]), S_MIN, 36500).toFixed(8);
    }
    next_short_term_stability(s, g) {
      const sinc = Math.pow(s, -this.param.w[19]) * Math.exp(this.param.w[17] * (g - 3 + this.param.w[18]));
      const maskedSinc = g >= 3 ? Math.max(sinc, 1) : sinc;
      return +clamp(s * maskedSinc, S_MIN, 36500).toFixed(8);
    }
    forgetting_curve;
    next_state(memory_state, t, g) {
      const { difficulty: d, stability: s } = memory_state ?? {
        difficulty: 0,
        stability: 0
      };
      if (t < 0) {
        throw new Error(`Invalid delta_t "${t}"`);
      }
      if (g < 0 || g > 4) {
        throw new Error(`Invalid grade "${g}"`);
      }
      if (d === 0 && s === 0) {
        return {
          difficulty: clamp(this.init_difficulty(g), 1, 10),
          stability: this.init_stability(g)
        };
      }
      if (g === 0) {
        return {
          difficulty: d,
          stability: s
        };
      }
      if (d < 1 || s < S_MIN) {
        throw new Error(`Invalid memory state { difficulty: ${d}, stability: ${s} }`);
      }
      const r = this.forgetting_curve(t, s);
      const s_after_success = this.next_recall_stability(d, s, r, g);
      const s_after_fail = this.next_forget_stability(d, s, r);
      const s_after_short_term = this.next_short_term_stability(s, g);
      let new_s = s_after_success;
      if (g === 1) {
        let [w_17, w_18] = [0, 0];
        if (this.param.enable_short_term) {
          w_17 = this.param.w[17];
          w_18 = this.param.w[18];
        }
        const next_s_min = s / Math.exp(w_17 * w_18);
        new_s = clamp(+next_s_min.toFixed(8), S_MIN, s_after_fail);
      }
      if (t === 0 && this.param.enable_short_term) {
        new_s = s_after_short_term;
      }
      const new_d = this.next_difficulty(d, g);
      return { difficulty: new_d, stability: new_s };
    }
  }

  class BasicScheduler extends AbstractScheduler {
    learningStepsStrategy;
    constructor(card, now, algorithm, strategies) {
      super(card, now, algorithm, strategies);
      let learningStepStrategy = BasicLearningStepsStrategy;
      if (this.strategies) {
        const custom_strategy = this.strategies.get(StrategyMode.LEARNING_STEPS);
        if (custom_strategy) {
          learningStepStrategy = custom_strategy;
        }
      }
      this.learningStepsStrategy = learningStepStrategy;
    }
    getLearningInfo(card, grade) {
      const parameters = this.algorithm.parameters;
      card.learning_steps = card.learning_steps || 0;
      const steps_strategy = this.learningStepsStrategy(parameters, card.state, this.current.state === State.Learning && grade !== Rating.Again && grade !== Rating.Hard ? card.learning_steps + 1 : card.learning_steps);
      const scheduled_minutes = Math.max(0, steps_strategy[grade]?.scheduled_minutes ?? 0);
      const next_steps = Math.max(0, steps_strategy[grade]?.next_step ?? 0);
      return {
        scheduled_minutes,
        next_steps
      };
    }
    applyLearningSteps(nextCard, grade, to_state) {
      const { scheduled_minutes, next_steps } = this.getLearningInfo(this.current, grade);
      if (scheduled_minutes > 0 && scheduled_minutes < 1440) {
        nextCard.learning_steps = next_steps;
        nextCard.scheduled_days = 0;
        nextCard.state = to_state;
        nextCard.due = date_scheduler(this.review_time, Math.round(scheduled_minutes), false);
      } else {
        nextCard.state = State.Review;
        if (scheduled_minutes >= 1440) {
          nextCard.learning_steps = next_steps;
          nextCard.due = date_scheduler(this.review_time, Math.round(scheduled_minutes), false);
          nextCard.scheduled_days = Math.floor(scheduled_minutes / 1440);
        } else {
          nextCard.learning_steps = 0;
          const interval = this.algorithm.next_interval(nextCard.stability, this.elapsed_days);
          nextCard.scheduled_days = interval;
          nextCard.due = date_scheduler(this.review_time, interval, true);
        }
      }
    }
    newState(grade) {
      const exist = this.next.get(grade);
      if (exist) {
        return exist;
      }
      const next = TypeConvert.card(this.current);
      next.difficulty = clamp(this.algorithm.init_difficulty(grade), 1, 10);
      next.stability = this.algorithm.init_stability(grade);
      this.applyLearningSteps(next, grade, State.Learning);
      const item = {
        card: next,
        log: this.buildLog(grade)
      };
      this.next.set(grade, item);
      return item;
    }
    learningState(grade) {
      const exist = this.next.get(grade);
      if (exist) {
        return exist;
      }
      const { state, difficulty, stability } = this.last;
      const next = TypeConvert.card(this.current);
      next.difficulty = this.algorithm.next_difficulty(difficulty, grade);
      next.stability = this.algorithm.next_short_term_stability(stability, grade);
      this.applyLearningSteps(next, grade, state);
      const item = {
        card: next,
        log: this.buildLog(grade)
      };
      this.next.set(grade, item);
      return item;
    }
    reviewState(grade) {
      const exist = this.next.get(grade);
      if (exist) {
        return exist;
      }
      const interval = this.elapsed_days;
      const { difficulty, stability } = this.last;
      const retrievability = this.algorithm.forgetting_curve(interval, stability);
      const next_again = TypeConvert.card(this.current);
      const next_hard = TypeConvert.card(this.current);
      const next_good = TypeConvert.card(this.current);
      const next_easy = TypeConvert.card(this.current);
      this.next_ds(next_again, next_hard, next_good, next_easy, difficulty, stability, retrievability);
      this.next_interval(next_hard, next_good, next_easy, interval);
      this.next_state(next_hard, next_good, next_easy);
      this.applyLearningSteps(next_again, Rating.Again, State.Relearning);
      next_again.lapses += 1;
      const item_again = {
        card: next_again,
        log: this.buildLog(Rating.Again)
      };
      const item_hard = {
        card: next_hard,
        log: super.buildLog(Rating.Hard)
      };
      const item_good = {
        card: next_good,
        log: super.buildLog(Rating.Good)
      };
      const item_easy = {
        card: next_easy,
        log: super.buildLog(Rating.Easy)
      };
      this.next.set(Rating.Again, item_again);
      this.next.set(Rating.Hard, item_hard);
      this.next.set(Rating.Good, item_good);
      this.next.set(Rating.Easy, item_easy);
      return this.next.get(grade);
    }
    next_ds(next_again, next_hard, next_good, next_easy, difficulty, stability, retrievability) {
      next_again.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Again);
      const nextSMin = stability / Math.exp(this.algorithm.parameters.w[17] * this.algorithm.parameters.w[18]);
      const s_after_fail = this.algorithm.next_forget_stability(difficulty, stability, retrievability);
      next_again.stability = clamp(+nextSMin.toFixed(8), S_MIN, s_after_fail);
      next_hard.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Hard);
      next_hard.stability = this.algorithm.next_recall_stability(difficulty, stability, retrievability, Rating.Hard);
      next_good.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Good);
      next_good.stability = this.algorithm.next_recall_stability(difficulty, stability, retrievability, Rating.Good);
      next_easy.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Easy);
      next_easy.stability = this.algorithm.next_recall_stability(difficulty, stability, retrievability, Rating.Easy);
    }
    next_interval(next_hard, next_good, next_easy, interval) {
      let hard_interval, good_interval;
      hard_interval = this.algorithm.next_interval(next_hard.stability, interval);
      good_interval = this.algorithm.next_interval(next_good.stability, interval);
      hard_interval = Math.min(hard_interval, good_interval);
      good_interval = Math.max(good_interval, hard_interval + 1);
      const easy_interval = Math.max(this.algorithm.next_interval(next_easy.stability, interval), good_interval + 1);
      next_hard.scheduled_days = hard_interval;
      next_hard.due = date_scheduler(this.review_time, hard_interval, true);
      next_good.scheduled_days = good_interval;
      next_good.due = date_scheduler(this.review_time, good_interval, true);
      next_easy.scheduled_days = easy_interval;
      next_easy.due = date_scheduler(this.review_time, easy_interval, true);
    }
    next_state(next_hard, next_good, next_easy) {
      next_hard.state = State.Review;
      next_hard.learning_steps = 0;
      next_good.state = State.Review;
      next_good.learning_steps = 0;
      next_easy.state = State.Review;
      next_easy.learning_steps = 0;
    }
  }

  class LongTermScheduler extends AbstractScheduler {
    newState(grade) {
      const exist = this.next.get(grade);
      if (exist) {
        return exist;
      }
      this.current.scheduled_days = 0;
      this.current.elapsed_days = 0;
      const next_again = TypeConvert.card(this.current);
      const next_hard = TypeConvert.card(this.current);
      const next_good = TypeConvert.card(this.current);
      const next_easy = TypeConvert.card(this.current);
      this.init_ds(next_again, next_hard, next_good, next_easy);
      const first_interval = 0;
      this.next_interval(next_again, next_hard, next_good, next_easy, first_interval);
      this.next_state(next_again, next_hard, next_good, next_easy);
      this.update_next(next_again, next_hard, next_good, next_easy);
      return this.next.get(grade);
    }
    init_ds(next_again, next_hard, next_good, next_easy) {
      next_again.difficulty = clamp(this.algorithm.init_difficulty(Rating.Again), 1, 10);
      next_again.stability = this.algorithm.init_stability(Rating.Again);
      next_hard.difficulty = clamp(this.algorithm.init_difficulty(Rating.Hard), 1, 10);
      next_hard.stability = this.algorithm.init_stability(Rating.Hard);
      next_good.difficulty = clamp(this.algorithm.init_difficulty(Rating.Good), 1, 10);
      next_good.stability = this.algorithm.init_stability(Rating.Good);
      next_easy.difficulty = clamp(this.algorithm.init_difficulty(Rating.Easy), 1, 10);
      next_easy.stability = this.algorithm.init_stability(Rating.Easy);
    }
    learningState(grade) {
      return this.reviewState(grade);
    }
    reviewState(grade) {
      const exist = this.next.get(grade);
      if (exist) {
        return exist;
      }
      const interval = this.elapsed_days;
      const { difficulty, stability } = this.last;
      const retrievability = this.algorithm.forgetting_curve(interval, stability);
      const next_again = TypeConvert.card(this.current);
      const next_hard = TypeConvert.card(this.current);
      const next_good = TypeConvert.card(this.current);
      const next_easy = TypeConvert.card(this.current);
      this.next_ds(next_again, next_hard, next_good, next_easy, difficulty, stability, retrievability);
      this.next_interval(next_again, next_hard, next_good, next_easy, interval);
      this.next_state(next_again, next_hard, next_good, next_easy);
      next_again.lapses += 1;
      this.update_next(next_again, next_hard, next_good, next_easy);
      return this.next.get(grade);
    }
    next_ds(next_again, next_hard, next_good, next_easy, difficulty, stability, retrievability) {
      next_again.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Again);
      const s_after_fail = this.algorithm.next_forget_stability(difficulty, stability, retrievability);
      next_again.stability = clamp(stability, S_MIN, s_after_fail);
      next_hard.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Hard);
      next_hard.stability = this.algorithm.next_recall_stability(difficulty, stability, retrievability, Rating.Hard);
      next_good.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Good);
      next_good.stability = this.algorithm.next_recall_stability(difficulty, stability, retrievability, Rating.Good);
      next_easy.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Easy);
      next_easy.stability = this.algorithm.next_recall_stability(difficulty, stability, retrievability, Rating.Easy);
    }
    next_interval(next_again, next_hard, next_good, next_easy, interval) {
      let again_interval, hard_interval, good_interval, easy_interval;
      again_interval = this.algorithm.next_interval(next_again.stability, interval);
      hard_interval = this.algorithm.next_interval(next_hard.stability, interval);
      good_interval = this.algorithm.next_interval(next_good.stability, interval);
      easy_interval = this.algorithm.next_interval(next_easy.stability, interval);
      again_interval = Math.min(again_interval, hard_interval);
      hard_interval = Math.max(hard_interval, again_interval + 1);
      good_interval = Math.max(good_interval, hard_interval + 1);
      easy_interval = Math.max(easy_interval, good_interval + 1);
      next_again.scheduled_days = again_interval;
      next_again.due = date_scheduler(this.review_time, again_interval, true);
      next_hard.scheduled_days = hard_interval;
      next_hard.due = date_scheduler(this.review_time, hard_interval, true);
      next_good.scheduled_days = good_interval;
      next_good.due = date_scheduler(this.review_time, good_interval, true);
      next_easy.scheduled_days = easy_interval;
      next_easy.due = date_scheduler(this.review_time, easy_interval, true);
    }
    next_state(next_again, next_hard, next_good, next_easy) {
      next_again.state = State.Review;
      next_again.learning_steps = 0;
      next_hard.state = State.Review;
      next_hard.learning_steps = 0;
      next_good.state = State.Review;
      next_good.learning_steps = 0;
      next_easy.state = State.Review;
      next_easy.learning_steps = 0;
    }
    update_next(next_again, next_hard, next_good, next_easy) {
      const item_again = {
        card: next_again,
        log: this.buildLog(Rating.Again)
      };
      const item_hard = {
        card: next_hard,
        log: super.buildLog(Rating.Hard)
      };
      const item_good = {
        card: next_good,
        log: super.buildLog(Rating.Good)
      };
      const item_easy = {
        card: next_easy,
        log: super.buildLog(Rating.Easy)
      };
      this.next.set(Rating.Again, item_again);
      this.next.set(Rating.Hard, item_hard);
      this.next.set(Rating.Good, item_good);
      this.next.set(Rating.Easy, item_easy);
    }
  }

  class Reschedule {
    fsrs;
    constructor(fsrs) {
      this.fsrs = fsrs;
    }
    replay(card, reviewed, rating) {
      return this.fsrs.next(card, reviewed, rating);
    }
    handleManualRating(card, state, reviewed, elapsed_days, stability, difficulty, due) {
      if (typeof state === "undefined") {
        throw new Error("reschedule: state is required for manual rating");
      }
      let log;
      let next_card;
      if (state === State.New) {
        log = {
          rating: Rating.Manual,
          state,
          due: due ?? reviewed,
          stability: card.stability,
          difficulty: card.difficulty,
          elapsed_days,
          last_elapsed_days: card.elapsed_days,
          scheduled_days: card.scheduled_days,
          learning_steps: card.learning_steps,
          review: reviewed
        };
        next_card = createEmptyCard(reviewed);
        next_card.last_review = reviewed;
      } else {
        if (typeof due === "undefined") {
          throw new Error("reschedule: due is required for manual rating");
        }
        const scheduled_days = date_diff(due, reviewed, "days");
        log = {
          rating: Rating.Manual,
          state: card.state,
          due: card.last_review || card.due,
          stability: card.stability,
          difficulty: card.difficulty,
          elapsed_days,
          last_elapsed_days: card.elapsed_days,
          scheduled_days: card.scheduled_days,
          learning_steps: card.learning_steps,
          review: reviewed
        };
        next_card = {
          ...card,
          state,
          due,
          last_review: reviewed,
          stability: stability || card.stability,
          difficulty: difficulty || card.difficulty,
          elapsed_days,
          scheduled_days,
          reps: card.reps + 1
        };
      }
      return { card: next_card, log };
    }
    reschedule(current_card, reviews) {
      const collections = [];
      let cur_card = createEmptyCard(current_card.due);
      for (const review of reviews) {
        let item;
        review.review = TypeConvert.time(review.review);
        if (review.rating === Rating.Manual) {
          let interval = 0;
          if (cur_card.state !== State.New && cur_card.last_review) {
            interval = date_diff(review.review, cur_card.last_review, "days");
          }
          item = this.handleManualRating(cur_card, review.state, review.review, interval, review.stability, review.difficulty, review.due ? TypeConvert.time(review.due) : undefined);
        } else {
          item = this.replay(cur_card, review.review, review.rating);
        }
        collections.push(item);
        cur_card = item.card;
      }
      return collections;
    }
    calculateManualRecord(current_card, now, record_log_item, update_memory) {
      if (!record_log_item) {
        return null;
      }
      const { card: reschedule_card, log } = record_log_item;
      const cur_card = TypeConvert.card(current_card);
      if (cur_card.due.getTime() === reschedule_card.due.getTime()) {
        return null;
      }
      cur_card.scheduled_days = date_diff(reschedule_card.due, cur_card.due, "days");
      return this.handleManualRating(cur_card, reschedule_card.state, TypeConvert.time(now), log.elapsed_days, update_memory ? reschedule_card.stability : undefined, update_memory ? reschedule_card.difficulty : undefined, reschedule_card.due);
    }
  }

  class FSRS extends FSRSAlgorithm {
    strategyHandler = /* @__PURE__ */ new Map;
    Scheduler;
    constructor(param) {
      super(param);
      const { enable_short_term } = this.parameters;
      this.Scheduler = enable_short_term ? BasicScheduler : LongTermScheduler;
    }
    params_handler_proxy() {
      const _this = this;
      return {
        set: function(target, prop, value) {
          if (prop === "request_retention" && Number.isFinite(value)) {
            _this.intervalModifier = _this.calculate_interval_modifier(Number(value));
          } else if (prop === "enable_short_term") {
            _this.Scheduler = value === true ? BasicScheduler : LongTermScheduler;
          } else if (prop === "w") {
            value = migrateParameters(value, target.relearning_steps.length, target.enable_short_term);
            _this.forgetting_curve = forgetting_curve.bind(this, value);
            _this.intervalModifier = _this.calculate_interval_modifier(Number(target.request_retention));
          }
          Reflect.set(target, prop, value);
          return true;
        }
      };
    }
    useStrategy(mode, handler) {
      this.strategyHandler.set(mode, handler);
      return this;
    }
    clearStrategy(mode) {
      if (mode) {
        this.strategyHandler.delete(mode);
      } else {
        this.strategyHandler.clear();
      }
      return this;
    }
    getScheduler(card, now) {
      const schedulerStrategy = this.strategyHandler.get(StrategyMode.SCHEDULER);
      const Scheduler = schedulerStrategy || this.Scheduler;
      const instance = new Scheduler(card, now, this, this.strategyHandler);
      return instance;
    }
    repeat(card, now, afterHandler) {
      const instance = this.getScheduler(card, now);
      const recordLog = instance.preview();
      if (afterHandler && typeof afterHandler === "function") {
        return afterHandler(recordLog);
      } else {
        return recordLog;
      }
    }
    next(card, now, grade, afterHandler) {
      const instance = this.getScheduler(card, now);
      const g = TypeConvert.rating(grade);
      if (g === Rating.Manual) {
        throw new Error("Cannot review a manual rating");
      }
      const recordLogItem = instance.review(g);
      if (afterHandler && typeof afterHandler === "function") {
        return afterHandler(recordLogItem);
      } else {
        return recordLogItem;
      }
    }
    get_retrievability(card, now, format = true) {
      const processedCard = TypeConvert.card(card);
      now = now ? TypeConvert.time(now) : /* @__PURE__ */ new Date;
      const t = processedCard.state !== State.New ? Math.max(date_diff(now, processedCard.last_review, "days"), 0) : 0;
      const r = processedCard.state !== State.New ? this.forgetting_curve(t, +processedCard.stability.toFixed(8)) : 0;
      return format ? `${(r * 100).toFixed(2)}%` : r;
    }
    rollback(card, log, afterHandler) {
      const processedCard = TypeConvert.card(card);
      const processedLog = TypeConvert.review_log(log);
      if (processedLog.rating === Rating.Manual) {
        throw new Error("Cannot rollback a manual rating");
      }
      let last_due;
      let last_review;
      let last_lapses;
      switch (processedLog.state) {
        case State.New:
          last_due = processedLog.due;
          last_review = undefined;
          last_lapses = 0;
          break;
        case State.Learning:
        case State.Relearning:
        case State.Review:
          last_due = processedLog.review;
          last_review = processedLog.due;
          last_lapses = processedCard.lapses - (processedLog.rating === Rating.Again && processedLog.state === State.Review ? 1 : 0);
          break;
      }
      const prevCard = {
        ...processedCard,
        due: last_due,
        stability: processedLog.stability,
        difficulty: processedLog.difficulty,
        elapsed_days: processedLog.last_elapsed_days,
        scheduled_days: processedLog.scheduled_days,
        reps: Math.max(0, processedCard.reps - 1),
        lapses: Math.max(0, last_lapses),
        learning_steps: processedLog.learning_steps,
        state: processedLog.state,
        last_review
      };
      if (afterHandler && typeof afterHandler === "function") {
        return afterHandler(prevCard);
      } else {
        return prevCard;
      }
    }
    forget(card, now, reset_count = false, afterHandler) {
      const processedCard = TypeConvert.card(card);
      now = TypeConvert.time(now);
      const scheduled_days = processedCard.state === State.New ? 0 : date_diff(now, processedCard.due, "days");
      const forget_log = {
        rating: Rating.Manual,
        state: processedCard.state,
        due: processedCard.due,
        stability: processedCard.stability,
        difficulty: processedCard.difficulty,
        elapsed_days: 0,
        last_elapsed_days: processedCard.elapsed_days,
        scheduled_days,
        learning_steps: processedCard.learning_steps,
        review: now
      };
      const forget_card = {
        ...processedCard,
        due: now,
        stability: 0,
        difficulty: 0,
        elapsed_days: 0,
        scheduled_days: 0,
        reps: reset_count ? 0 : processedCard.reps,
        lapses: reset_count ? 0 : processedCard.lapses,
        learning_steps: 0,
        state: State.New,
        last_review: processedCard.last_review
      };
      const recordLogItem = { card: forget_card, log: forget_log };
      if (afterHandler && typeof afterHandler === "function") {
        return afterHandler(recordLogItem);
      } else {
        return recordLogItem;
      }
    }
    reschedule(current_card, reviews = [], options = {}) {
      const {
        recordLogHandler,
        reviewsOrderBy,
        skipManual = true,
        now = /* @__PURE__ */ new Date,
        update_memory_state: updateMemoryState = false
      } = options;
      if (reviewsOrderBy && typeof reviewsOrderBy === "function") {
        reviews.sort(reviewsOrderBy);
      }
      if (skipManual) {
        reviews = reviews.filter((review) => review.rating !== Rating.Manual);
      }
      const rescheduleSvc = new Reschedule(this);
      const collections = rescheduleSvc.reschedule(options.first_card || createEmptyCard(), reviews);
      const len = collections.length;
      const cur_card = TypeConvert.card(current_card);
      const manual_item = rescheduleSvc.calculateManualRecord(cur_card, now, len ? collections[len - 1] : undefined, updateMemoryState);
      if (recordLogHandler && typeof recordLogHandler === "function") {
        return {
          collections: collections.map(recordLogHandler),
          reschedule_item: manual_item ? recordLogHandler(manual_item) : null
        };
      }
      return {
        collections,
        reschedule_item: manual_item
      };
    }
  }
  var fsrs = (params) => {
    return new FSRS(params || {});
  };

  // src/lianki.user.ts
  if (window.self === window.top) {
    globalThis.unload_Lianki?.();
    globalThis.unload_Lianki = main();
  }
  function compareHLC(a, b) {
    if (!a)
      return -1;
    if (!b)
      return 1;
    if (a.timestamp !== b.timestamp)
      return a.timestamp - b.timestamp;
    if (a.counter !== b.counter)
      return a.counter - b.counter;
    return a.deviceId.localeCompare(b.deviceId);
  }
  function newHLC(deviceId, lastHLC = null) {
    const now = Date.now();
    if (!lastHLC || now > lastHLC.timestamp) {
      return { timestamp: now, counter: 0, deviceId };
    }
    return {
      timestamp: lastHLC.timestamp,
      counter: lastHLC.counter + 1,
      deviceId
    };
  }
  function getOrCreateDeviceId() {
    let deviceId = GM_getValue("lk:deviceId", "");
    if (!deviceId) {
      deviceId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === "x" ? r : r & 3 | 8;
        return v.toString(16);
      });
      GM_setValue("lk:deviceId", deviceId);
    }
    return deviceId;
  }
  var CARD_PREFIX = "lk:c:";
  var INDEX_KEY = "lk:card-index";
  var MAX_CARDS = 2000;
  function hashUrl(url) {
    let h = 5381;
    for (let i = 0;i < url.length; i++)
      h = ((h << 5) + h ^ url.charCodeAt(i)) >>> 0;
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
      if (!raw)
        return null;
      const c = JSON.parse(raw);
      return c._url === url ? c : null;
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
          const maxI = idx.reduce((mi, e, i, a) => new Date(e.due) > new Date(a[mi].due) ? i : mi, 0);
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
      return this._index().map((e) => {
        const raw = GM_getValue(CARD_PREFIX + e.hash, "");
        return raw ? { url: e.url, ...JSON.parse(raw) } : null;
      }).filter(Boolean);
    }
    getDueCards(limit = 10) {
      const now = new Date;
      return this._index().filter((e) => new Date(e.due) <= now).sort((a, b) => new Date(a.due) - new Date(b.due)).slice(0, limit).map((e) => {
        const raw = GM_getValue(CARD_PREFIX + e.hash, "");
        return raw ? { url: e.url, ...JSON.parse(raw) } : null;
      }).filter(Boolean);
    }
  }

  class GMConfigStorage {
    getConfig() {
      const cfg = JSON.parse(GM_getValue("lk:config", "{}"));
      if (!cfg.lastSyncHLC)
        cfg.lastSyncHLC = null;
      if (!cfg.lastSyncTime)
        cfg.lastSyncTime = 0;
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
        createdAt: Date.now()
      });
      GM_setValue("lk:queue", JSON.stringify(q));
    }
    removeFromQueue(id) {
      GM_setValue("lk:queue", JSON.stringify(this.getQueue().filter((e) => e.id !== id)));
    }
    updateQueueItem(id, updates) {
      GM_setValue("lk:queue", JSON.stringify(this.getQueue().map((e) => e.id === id ? { ...e, ...updates } : e)));
    }
  }
  async function syncToSiteDB() {
    const cs = new GMCardStorage;
    const index = cs._index();
    if (!index.length)
      return;
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
        if (!raw)
          continue;
        const { note, hlc, dirty } = JSON.parse(raw);
        if (!note?.card)
          continue;
        store.put({
          url: note.url || entry.url,
          title: note.title || note.url || entry.url,
          card: note.card,
          log: note.log || [],
          hlc: hlc || note.hlc,
          synced: !dirty
        }, "card:" + (note.url || entry.url));
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

  class LocalFSRS {
    constructor(params = null) {
      this.Rating = Rating;
      this.params = params || generatorParameters({});
      this.scheduler = fsrs(this.params);
    }
    calculateOptions(card, now = new Date) {
      const scheduleInfo = this.scheduler.repeat(card, now);
      return [
        {
          rating: 1,
          label: "Again",
          card: scheduleInfo[this.Rating.Again].card,
          log: scheduleInfo[this.Rating.Again].log,
          due: this.formatDue(scheduleInfo[this.Rating.Again].card.due)
        },
        {
          rating: 2,
          label: "Hard",
          card: scheduleInfo[this.Rating.Hard].card,
          log: scheduleInfo[this.Rating.Hard].log,
          due: this.formatDue(scheduleInfo[this.Rating.Hard].card.due)
        },
        {
          rating: 3,
          label: "Good",
          card: scheduleInfo[this.Rating.Good].card,
          log: scheduleInfo[this.Rating.Good].log,
          due: this.formatDue(scheduleInfo[this.Rating.Good].card.due)
        },
        {
          rating: 4,
          label: "Easy",
          card: scheduleInfo[this.Rating.Easy].card,
          log: scheduleInfo[this.Rating.Easy].log,
          due: this.formatDue(scheduleInfo[this.Rating.Easy].card.due)
        }
      ];
    }
    formatDue(dueDate) {
      const now = new Date;
      const diffMs = new Date(dueDate) - now;
      const diffMins = Math.round(diffMs / 60000);
      const diffHours = Math.round(diffMs / 3600000);
      const diffDays = Math.round(diffMs / 86400000);
      if (diffMins < 1)
        return "now";
      if (diffMins < 60)
        return `${diffMins}m`;
      if (diffHours < 24)
        return `${diffHours}h`;
      if (diffDays < 30)
        return `${diffDays}d`;
      const diffMonths = Math.round(diffDays / 30);
      if (diffMonths < 12)
        return `${diffMonths}mo`;
      const diffYears = Math.round(diffDays / 365);
      return `${diffYears}y`;
    }
    newCard() {
      const now = new Date;
      return {
        due: now,
        stability: 0,
        difficulty: 0,
        elapsed_days: 0,
        scheduled_days: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        last_review: now
      };
    }
    applyReview(card, rating, now = new Date) {
      const scheduleInfo = this.scheduler.repeat(card, now);
      const ratingKey = [
        this.Rating.Manual,
        this.Rating.Again,
        this.Rating.Hard,
        this.Rating.Good,
        this.Rating.Easy
      ][rating];
      return scheduleInfo[ratingKey];
    }
  }
  function main() {
    window.LIANKI_USERSCRIPT_INSTALLED = true;
    const ORIGIN = (() => {
      try {
        const u = new URL(GM_info?.script?.downloadURL || "");
        if (u.hostname === "lianki.com")
          u.hostname = "www.lianki.com";
        return u.origin;
      } catch {
        return "https://www.lianki.com";
      }
    })();
    function normalizeUrl(href) {
      try {
        const u = new URL(href);
        if (u.hostname === "youtu.be") {
          const id = u.pathname.slice(1);
          u.hostname = "www.youtube.com";
          u.pathname = "/watch";
          u.searchParams.set("v", id);
        }
        if (u.hostname.startsWith("m."))
          u.hostname = "www." + u.hostname.slice(2);
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
          "igshid"
        ])
          u.searchParams.delete(p);
        u.searchParams.sort();
        return u.toString();
      } catch {
        return href;
      }
    }
    if (location.hostname === new URL(ORIGIN).hostname) {
      setTimeout(() => syncToSiteDB(), 500);
      return () => {};
    }
    const ac = new AbortController;
    const { signal } = ac;
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    let userPreferences = {
      mobileExcludeDomains: []
    };
    async function loadPreferences() {
      try {
        const cached = GM_getValue("lk:preferences", "");
        if (cached) {
          const { data, ts } = JSON.parse(cached);
          if (Date.now() - ts < 60 * 60 * 1000) {
            userPreferences = data;
            return;
          }
        }
        const prefs = await api("/api/preferences");
        userPreferences = prefs;
        GM_setValue("lk:preferences", JSON.stringify({ data: prefs, ts: Date.now() }));
      } catch (err) {
        console.log("[Lianki] Failed to load preferences, using defaults:", err);
      }
    }
    let state = {
      phase: "idle",
      noteId: null,
      options: null,
      error: null,
      message: null,
      notes: "",
      notesSynced: true
    };
    let fab = null;
    let dialog = null;
    let prefetchedNextUrl = null;
    let prefetchLink = null;
    let videoObserver = null;
    const CURRENT_VERSION = GM_info?.script?.version ?? "0.0.0";
    let updatePrompted = false;
    function isNewerVersion(a, b) {
      const seg = (v) => v.split(".").map((n) => parseInt(n) || 0);
      const [aa, ab, ac2] = seg(a);
      const [ba, bb, bc] = seg(b);
      return aa !== ba ? aa > ba : ab !== bb ? ab > bb : ac2 > bc;
    }
    function checkVersion(r) {
      if (updatePrompted)
        return;
      const sv = r.headers.get("x-lianki-version");
      if (sv && isNewerVersion(sv, CURRENT_VERSION)) {
        updatePrompted = true;
        window.open(`${ORIGIN}/lianki.user.js`, "_blank");
      }
    }
    function gmFetch(url, opts = {}) {
      return new Promise((resolve, reject) => {
        const token = GM_getValue("lk:token", "");
        const headers = { ...opts.headers };
        if (token)
          headers["Authorization"] = `Bearer ${token}`;
        GM_xmlhttpRequest({
          method: (opts.method || "GET").toUpperCase(),
          url: String(url),
          headers,
          data: opts.body ?? undefined,
          withCredentials: opts.credentials === "include",
          onload(resp) {
            const hdrs = {};
            for (const line of resp.responseHeaders.split(`\r
`)) {
              const i = line.indexOf(": ");
              if (i > 0) {
                const name = line.slice(0, i).toLowerCase();
                if (name !== "set-cookie")
                  hdrs[name] = line.slice(i + 2);
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
              text: () => Promise.resolve(resp.responseText)
            });
          },
          onerror() {
            reject(new Error("Network error"));
          },
          onabort() {
            reject(new Error("Request aborted"));
          }
        });
      });
    }
    const api = (path, opts = {}) => gmFetch(`${ORIGIN}${path}`, { credentials: "include", ...opts }).then((r) => {
      if (r.status === 401) {
        const e = new Error("Login required");
        e.status = 401;
        throw e;
      }
      if (!r.ok)
        throw new Error(`HTTP ${r.status}`);
      checkVersion(r);
      return r.json();
    });
    function gmCache(key, ttlMs, fn) {
      try {
        const raw = GM_getValue(key);
        if (raw) {
          const { v, exp } = JSON.parse(raw);
          if (Date.now() < exp)
            return Promise.resolve(v);
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
    const noteKey = (url) => `lk:note:${url}`;
    const addNote = (url, title) => gmCache(noteKey(url), 10 * 60 * 1000, () => api("/api/fsrs/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, title })
    }));
    const buildExcludeDomainsParam = () => {
      if (!isMobile)
        return "";
      const domains = userPreferences.mobileExcludeDomains || [];
      if (domains.length === 0)
        return "";
      return `&excludeDomains=${domains.join(",")}`;
    };
    const saveNotes = (id, notes) => api(`/api/fsrs/notes?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes })
    });
    const getOptions = (id) => api(`/api/fsrs/options?id=${encodeURIComponent(id)}`);
    const submitReview = (id, rating) => api(`/api/fsrs/review/${rating}/?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
    const deleteNote = (id) => api(`/api/fsrs/delete?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
    const getNextUrl = () => api(`/api/fsrs/next-url?${buildExcludeDomainsParam().slice(1)}`);
    const btn = (bg, extra = "") => `all:initial;display:inline-block;box-sizing:border-box;background:${bg};color:${bg === "transparent" ? "var(--lk-fg)" : "#eee"};border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;min-width:60px;line-height:1.5;text-align:center;${extra}`;
    function prefetchNextPage(pageUrl) {
      if (!pageUrl)
        return;
      if (prefetchLink) {
        prefetchLink.remove();
        prefetchLink = null;
      }
      prefetchLink = document.createElement("link");
      prefetchLink.rel = "prefetch";
      prefetchLink.href = pageUrl;
      prefetchLink.as = "document";
      document.head.appendChild(prefetchLink);
      console.log("[Lianki] Prefetching next page:", pageUrl);
    }
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
        overflow: "hidden"
      });
      let isDragged = false;
      const BTN_BASE = "border:none;cursor:pointer;background:transparent;color:#eee;" + "padding:10px 14px;font-size:15px;font-weight:bold;touch-action:manipulation;" + "transition:background 0.2s;";
      const BTN_HOVER = "background:rgba(255,255,255,0.1);";
      const makeBtn = (text, title, action) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.title = title;
        b.style.cssText = BTN_BASE;
        b.addEventListener("mouseenter", () => {
          if (!isDragged)
            b.style.background = "rgba(255,255,255,0.1)";
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
      const liankiBtn = makeBtn("\uD83D\uDD16", "Lianki (Alt+F)", () => dialog ? closeDialog() : openDialog());
      const fasterBtn = makeBtn("⏩", "Faster (./b)", () => pardon(0, 1.2));
      const makeSeparator = () => {
        const sep = document.createElement("div");
        sep.style.cssText = "width:1px;height:24px;background:rgba(255,255,255,0.15);align-self:center;";
        return sep;
      };
      container.append(slowerBtn, makeSeparator(), liankiBtn, makeSeparator(), fasterBtn);
      const updateVideoButtonVisibility = () => {
        const hasVideo = document.querySelector("video,audio") !== null;
        const display = hasVideo ? "" : "none";
        slowerBtn.style.display = display;
        fasterBtn.style.display = display;
        const separators = container.querySelectorAll("div");
        if (hasVideo) {
          separators[0].style.display = "";
          separators[1].style.display = "";
        } else {
          separators[0].style.display = "none";
          separators[1].style.display = "none";
        }
      };
      const EDGE_THRESHOLD = 5;
      const updateBorderRadius = () => {
        const r = container.getBoundingClientRect();
        const atLeft = r.left <= EDGE_THRESHOLD;
        const atRight = r.right >= window.innerWidth - EDGE_THRESHOLD;
        const atTop = r.top <= EDGE_THRESHOLD;
        const atBottom = r.bottom >= window.innerHeight - EDGE_THRESHOLD;
        let radius = "999px";
        if (atLeft && atTop)
          radius = "0 999px 999px 0";
        else if (atRight && atTop)
          radius = "999px 0 0 999px";
        else if (atLeft && atBottom)
          radius = "0 999px 999px 0";
        else if (atRight && atBottom)
          radius = "999px 0 0 999px";
        else if (atLeft)
          radius = "0 999px 999px 0";
        else if (atRight)
          radius = "999px 0 0 999px";
        else if (atTop)
          radius = "0 0 999px 999px";
        else if (atBottom)
          radius = "999px 999px 0 0";
        container.style.borderRadius = radius;
      };
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
      updateVideoButtonVisibility();
      videoObserver = new MutationObserver(updateVideoButtonVisibility);
      videoObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
      window.addEventListener("resize", constrainPosition, { signal });
      let dragging = false;
      let startX = 0, startY = 0, startLeft = 0, startTop = 0;
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
        if (!dragging)
          return;
        const dx = clientX - startX, dy = clientY - startY;
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
          GM_setValue("lianki_pos", JSON.stringify({ x: parseInt(container.style.left), y: parseInt(container.style.top) }));
          updateBorderRadius();
        }
        dragging = false;
      };
      container.addEventListener("touchstart", (e) => initDrag(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
      container.addEventListener("touchmove", (e) => {
        if (dragging) {
          e.preventDefault();
          moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
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
      updateBorderRadius();
      return container;
    }
    function mountDialog() {
      const shadowHost = document.createElement("div");
      shadowHost.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";
      const shadow = shadowHost.attachShadow({ mode: "open" });
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
        zIndex: "2147483645"
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
        boxSizing: "border-box"
      });
      shadow.appendChild(backdrop);
      shadow.appendChild(el);
      document.body.appendChild(shadowHost);
      el._backdrop = backdrop;
      el._shadowHost = shadowHost;
      return el;
    }
    function renderDialog() {
      if (!dialog)
        return;
      const { phase, options, error, message } = state;
      while (dialog.lastChild)
        dialog.removeChild(dialog.lastChild);
      const globalStyle = document.createElement("style");
      globalStyle.textContent = `
      * { font-family: system-ui, sans-serif; box-sizing: border-box; }
      div, span, button, a { all: revert; }
      button { cursor: pointer; }
    `;
      dialog.appendChild(globalStyle);
      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "16px"
      });
      const titleSpan = document.createElement("span");
      Object.assign(titleSpan.style, { fontWeight: "700", fontSize: "16px" });
      titleSpan.textContent = "\uD83D\uDD16 Lianki";
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "×";
      closeBtn.setAttribute("style", `${btn("transparent")};color:var(--lk-muted);font-size:20px;padding:0 6px;line-height:1`);
      closeBtn.addEventListener("click", closeDialog);
      header.appendChild(titleSpan);
      header.appendChild(closeBtn);
      dialog.appendChild(header);
      if (phase === "adding") {
        const styleEl = document.createElement("style");
        styleEl.textContent = "@keyframes lk-spin{to{transform:rotate(360deg)}}" + ".lk-spinner{display:inline-block;width:20px;height:20px;" + "border:3px solid #555;border-top-color:#7eb8f7;border-radius:50%;" + "animation:lk-spin 0.8s linear infinite;vertical-align:middle;margin-right:8px}";
        dialog.appendChild(styleEl);
        const wrap = document.createElement("div");
        Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "10px" });
        const spinRow = document.createElement("div");
        Object.assign(spinRow.style, { fontSize: "15px", fontWeight: "600" });
        const spinner = document.createElement("span");
        spinner.className = "lk-spinner";
        spinRow.appendChild(spinner);
        spinRow.appendChild(document.createTextNode("Adding note…"));
        const urlDiv = document.createElement("div");
        Object.assign(urlDiv.style, {
          color: "var(--lk-muted)",
          fontSize: "12px",
          wordBreak: "break-all"
        });
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
          flexWrap: "wrap"
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
          const token = prompt(`Paste your Lianki API token.

Generate one at: ${ORIGIN}/list

(Needed for Safari/Stay where cookies don't work)`);
          if (!token)
            return;
          GM_setValue("lk:token", token.trim());
          closeDialog();
          openDialog();
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
            `Version: ${CURRENT_VERSION}`
          ];
          if (state.errorDetails)
            parts.push(`
Response:
${state.errorDetails}`);
          const text = parts.join(`
`);
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
          opacity: ".8"
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
          marginBottom: "8px"
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
        hints.textContent = "A/H=Easy · S/J=Good · W/K=Hard · D/L=Again · T/M=Delete · Esc=Close";
        dialog.appendChild(hints);
        const notesRow = document.createElement("div");
        Object.assign(notesRow.style, { marginTop: "10px", position: "relative" });
        const notesInput = document.createElement("input");
        notesInput.type = "text";
        notesInput.maxLength = 128;
        notesInput.placeholder = "Notes…";
        notesInput.value = state.notes;
        notesInput.tabIndex = -1;
        Object.assign(notesInput.style, {
          width: "100%",
          boxSizing: "border-box",
          background: "var(--lk-input-bg)",
          color: "var(--lk-input-fg)",
          border: "1px solid var(--lk-input-border)",
          borderRadius: "6px",
          padding: "6px 28px 6px 8px",
          fontSize: "12px",
          outline: "none"
        });
        const syncIndicator = document.createElement("span");
        Object.assign(syncIndicator.style, {
          position: "absolute",
          right: "8px",
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: "13px",
          opacity: ".7",
          pointerEvents: "none"
        });
        syncIndicator.textContent = state.notesSynced ? "✓" : "⋯";
        let notesTimer = null;
        notesInput.addEventListener("input", () => {
          const val = notesInput.value.slice(0, 128);
          state.notes = val;
          state.notesSynced = false;
          syncIndicator.textContent = "⋯";
          clearTimeout(notesTimer);
          notesTimer = setTimeout(async () => {
            try {
              await saveNotes(state.noteId, val);
              state.notesSynced = true;
              syncIndicator.textContent = "✓";
            } catch {
              syncIndicator.textContent = "✗";
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
      if (offlineReady) {
        const indicator = document.createElement("div");
        Object.assign(indicator.style, {
          position: "absolute",
          top: "8px",
          right: "8px",
          fontSize: "11px",
          opacity: "0.6",
          display: "flex",
          alignItems: "center",
          gap: "4px"
        });
        const queue = queueStorage.getQueue();
        if (!navigator.onLine)
          indicator.textContent = "\uD83D\uDCF4 Offline";
        else if (syncInProgress)
          indicator.textContent = "\uD83D\uDD04 Syncing...";
        else if (queue.length > 0)
          indicator.textContent = `⏳ ${queue.length}`;
        else
          indicator.textContent = "✓";
        dialog.appendChild(indicator);
      }
    }
    function openDialog() {
      if (dialog)
        return;
      dialog = mountDialog();
      state = { phase: "adding", noteId: null, options: null, error: null, message: null };
      prefetchedNextUrl = null;
      renderDialog();
      dialog.focus();
      const url = normalizeUrl(location.href);
      addNote(url, document.title).then((note) => {
        state.noteId = note._id;
        state.notes = note.notes ?? "";
        state.notesSynced = true;
        getNextUrl().then((data) => {
          prefetchedNextUrl = data.url;
          if (data.url)
            prefetchNextPage(data.url);
        }).catch(() => {});
        if (note.options) {
          return { options: note.options };
        }
        return getOptions(note._id);
      }).then((data) => {
        state.phase = "reviewing";
        state.options = data.options;
        renderDialog();
      }).catch((err) => {
        state.phase = "error";
        state.error = err.message;
        state.errorDetails = err.details ?? null;
        renderDialog();
      });
    }
    function closeDialog() {
      if (!dialog)
        return;
      dialog._backdrop?.remove();
      dialog._shadowHost?.remove();
      dialog.remove();
      dialog = null;
      state = { phase: "idle", noteId: null, options: null, error: null, message: null };
      if (prefetchLink) {
        prefetchLink.remove();
        prefetchLink = null;
      }
    }
    async function doReview(rating) {
      if (state.phase !== "reviewing" || !state.noteId)
        return;
      try {
        const result = await submitReview(state.noteId, rating);
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
      if (state.phase !== "reviewing" || !state.noteId)
        return;
      try {
        const result = await deleteNote(state.noteId);
        gmCacheInvalidate(noteKey(normalizeUrl(location.href)));
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
      let nextUrl = prefetchedNextUrl;
      let nextTitle = null;
      prefetchedNextUrl = null;
      if (!nextUrl) {
        state.message = "Loading next card…";
        renderDialog();
        const data = await getNextUrl().catch(() => ({ url: null, title: null }));
        nextUrl = data.url;
        nextTitle = data.title;
        if (nextUrl) {
          prefetchNextPage(nextUrl);
          state.message = `Redirecting to:
${nextTitle || nextUrl}`;
          renderDialog();
        }
      }
      if (nextUrl && /^https?:\/\//.test(nextUrl)) {
        console.log("[Lianki] Storing intended URL:", nextUrl);
        GM_setValue("lk:nav_intended", JSON.stringify({ url: nextUrl, ts: Date.now() }));
        location.href = nextUrl;
      } else {
        state.message = `${doneMessage} — All done!`;
        renderDialog();
        setTimeout(closeDialog, 2000);
      }
    }
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
      Escape: () => closeDialog()
    };
    document.addEventListener("keydown", (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (dialog)
          closeDialog();
        else
          openDialog();
        return;
      }
      if (!dialog || state.phase !== "reviewing")
        return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)
        return;
      const action = KEYS[e.code];
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        action();
      }
    }, { capture: true, signal });
    (() => {
      let vcid = null;
      document.addEventListener("visibilitychange", trackHandler, { signal });
      function trackHandler() {
        const cb = () => {
          if (!navigator.mediaSession)
            return;
          navigator.mediaSession.setActionHandler("nexttrack", () => {
            pardon(0, 1.2);
          });
          navigator.mediaSession.setActionHandler("previoustrack", () => {
            pardon(-3, 0.7);
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
    loadPreferences();
    fab = createUI();
    async function checkRedirect() {
      try {
        const raw = GM_getValue("lk:nav_intended", "");
        if (!raw)
          return;
        const { url: intendedUrl, ts } = JSON.parse(raw);
        if (Date.now() - ts > 30000)
          return;
        const actualUrl = location.href;
        if (normalizeUrl(actualUrl) === normalizeUrl(intendedUrl)) {
          GM_setValue("lk:nav_intended", "");
          return;
        }
        console.log("[Lianki] Redirect detected:", intendedUrl, "→", actualUrl);
        const confirmed = confirm(`This page redirected from:
${intendedUrl}

` + `To:
${actualUrl}

` + `Update the card to point to the new URL?`);
        if (!confirmed) {
          console.log("[Lianki] User declined URL update");
          GM_setValue("lk:nav_intended", "");
          return;
        }
        const result = await api("/api/fsrs/update-url", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ oldUrl: intendedUrl, newUrl: actualUrl })
        });
        console.log("[Lianki] Card URL updated:", result);
        GM_setValue("lk:nav_intended", "");
        openDialog();
      } catch (err) {
        console.error("[Lianki] Failed to update card URL:", err);
      }
    }
    checkRedirect();
    if ("navigation" in window) {
      navigation.addEventListener("navigatesuccess", () => checkRedirect(), { signal });
    } else {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      history.pushState = function(...args) {
        originalPushState.apply(this, args);
        setTimeout(checkRedirect, 100);
      };
      history.replaceState = function(...args) {
        originalReplaceState.apply(this, args);
        setTimeout(checkRedirect, 100);
      };
      window.addEventListener("popstate", () => setTimeout(checkRedirect, 100), { signal });
    }
    const $$ = (sel) => [...document.querySelectorAll(sel)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const renderTime = (t) => [t / 3600 | 0, (t / 60 | 0) % 60, t % 60 | 0].map((e) => e.toString().padStart(2, "0")).join(":");
    const renderSpeed = (s) => "x" + s.toFixed(2);
    function centerTooltip(textContent) {
      const el = document.createElement("div");
      el.textContent = textContent;
      el.style.cssText = "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); " + "background: #0008; color: white; padding: 0.5rem; border-radius: 1rem; " + "z-index: 2147483647; pointer-events: none;";
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 500);
    }
    const videoSpeedMaps = new WeakMap;
    const markerCacheKey = (url) => `lk:markers:${normalizeUrl(url)}`;
    function loadLocalMarkers(url) {
      try {
        const raw = GM_getValue(markerCacheKey(url), "");
        if (!raw)
          return { markers: {}, lastSync: 0, dirty: false };
        return JSON.parse(raw);
      } catch {
        return { markers: {}, lastSync: 0, dirty: false };
      }
    }
    function saveLocalMarkers(url, markers, dirty = true) {
      const cache = {
        markers,
        lastSync: dirty ? loadLocalMarkers(url).lastSync : Date.now(),
        dirty
      };
      GM_setValue(markerCacheKey(url), JSON.stringify(cache));
    }
    async function pardon(dt = 0, speedMultiplier = 1, wait = 0) {
      const vs = $$("video,audio");
      const v = vs.filter((e) => !e.paused)[0];
      if (!v)
        return vs[0]?.click();
      const mergeNearbyMarkers = (time) => {
        if (speedMultiplier === 1)
          return;
        if (!videoSpeedMaps.has(v))
          videoSpeedMaps.set(v, new Map);
        const speedMap = videoSpeedMaps.get(v);
        const MERGE_THRESHOLD = 2;
        for (const [existingTime] of speedMap) {
          if (Math.abs(time - existingTime) < MERGE_THRESHOLD) {
            speedMap.delete(existingTime);
            console.log(`[Lianki] Merged marker: ${renderTime(existingTime)} @ ${renderTime(time)}`);
          }
        }
      };
      mergeNearbyMarkers(v.currentTime);
      if (dt !== 0)
        v.currentTime += dt;
      mergeNearbyMarkers(v.currentTime);
      if (speedMultiplier !== 1) {
        v.playbackRate *= speedMultiplier;
        const speedMap = videoSpeedMaps.get(v);
        speedMap.set(v.currentTime, v.playbackRate);
        console.log(`[Lianki] Speed marker: ${renderTime(v.currentTime)} → ${renderSpeed(v.playbackRate)}`);
        const url = normalizeUrl(location.href);
        const markers = Object.fromEntries(speedMap);
        saveLocalMarkers(url, markers, true);
      }
      centerTooltip((dt < 0 ? "<-" : "->") + " " + renderTime(v.currentTime) + " " + renderSpeed(v.playbackRate));
      if (wait)
        await sleep(wait);
      return true;
    }
    window.addEventListener("keydown", async (e) => {
      if (dialog)
        return;
      if (e.altKey || e.ctrlKey || e.metaKey)
        return;
      if (document?.activeElement?.isContentEditable)
        return;
      if (["INPUT", "TEXTAREA"].includes(document?.activeElement?.tagName))
        return;
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
    }, { capture: true });
    function setupVideoSpeedTracking(video) {
      const url = normalizeUrl(location.href);
      (async () => {
        try {
          const local = loadLocalMarkers(url);
          const { markers } = await api(`/api/fsrs/speed-markers?url=${encodeURIComponent(url)}`);
          const merged = { ...local.markers, ...markers };
          saveLocalMarkers(url, merged, false);
          if (!videoSpeedMaps.has(video))
            videoSpeedMaps.set(video, new Map);
          const speedMap = videoSpeedMaps.get(video);
          for (const [timestamp, speed] of Object.entries(merged)) {
            speedMap.set(parseFloat(timestamp), speed);
          }
          console.log(`[Lianki] Loaded ${Object.keys(merged).length} speed markers for ${url}`);
        } catch (err) {
          console.error("[Lianki] Failed to load speed markers:", err);
          const local = loadLocalMarkers(url);
          if (!videoSpeedMaps.has(video))
            videoSpeedMaps.set(video, new Map);
          const speedMap = videoSpeedMaps.get(video);
          for (const [timestamp, speed] of Object.entries(local.markers)) {
            speedMap.set(parseFloat(timestamp), speed);
          }
        }
      })();
      let lastCheckedTime = 0;
      video.addEventListener("timeupdate", () => {
        const speedMap = videoSpeedMaps.get(video);
        if (!speedMap || speedMap.size === 0)
          return;
        const currentTime = video.currentTime;
        const threshold = 0.5;
        if (Math.abs(currentTime - lastCheckedTime) < 0.3)
          return;
        lastCheckedTime = currentTime;
        for (const [markedTime, targetSpeed] of speedMap) {
          if (Math.abs(currentTime - markedTime) < threshold) {
            if (Math.abs(video.playbackRate - targetSpeed) > 0.01) {
              video.playbackRate = targetSpeed;
              centerTooltip(`Auto-speed: ${renderSpeed(targetSpeed)} @ ${renderTime(markedTime)}`);
              console.log(`[Lianki] Auto-adjusted to ${renderSpeed(targetSpeed)} at ${renderTime(currentTime)}`);
            }
            break;
          }
        }
      });
    }
    function observeVideos() {
      const tracked = new WeakSet;
      const trackVideo = (v) => {
        if (tracked.has(v))
          return;
        tracked.add(v);
        setupVideoSpeedTracking(v);
      };
      $$("video,audio").forEach(trackVideo);
      const observer = new MutationObserver(() => {
        $$("video,audio").forEach(trackVideo);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    observeVideos();
    setInterval(async () => {
      try {
        const url = normalizeUrl(location.href);
        const cache = loadLocalMarkers(url);
        if (!cache.dirty)
          return;
        console.log(`[Lianki] Syncing ${Object.keys(cache.markers).length} markers to DB...`);
        await api("/api/fsrs/speed-markers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, markers: cache.markers })
        });
        saveLocalMarkers(url, cache.markers, false);
        console.log("[Lianki] Sync complete");
      } catch (err) {
        console.error("[Lianki] Sync failed:", err);
      }
    }, 30000);
    let offlineReady = false;
    let cardStorage, configStorage, queueStorage, localFSRS;
    const deviceId = getOrCreateDeviceId();
    let syncInProgress = false;
    let syncTimer = null;
    function initOfflineStorage() {
      try {
        cardStorage = new GMCardStorage;
        configStorage = new GMConfigStorage;
        queueStorage = new GMQueueStorage;
        const config = configStorage.getConfig();
        localFSRS = new LocalFSRS(config.fsrsParams);
        offlineReady = true;
        console.log("[Lianki] Offline storage initialized");
        startBackgroundSync();
        setTimeout(() => prefetchDueCards(), 2000);
      } catch (err) {
        console.error("[Lianki] Failed to initialize offline storage:", err);
      }
    }
    const _originalOpenDialog = openDialog;
    openDialog = async function openDialogOffline() {
      if (dialog)
        return;
      dialog = mountDialog();
      state = { phase: "adding", noteId: null, options: null, error: null, message: null };
      prefetchedNextUrl = null;
      renderDialog();
      dialog.focus();
      const url = normalizeUrl(location.href);
      if (offlineReady) {
        try {
          const cachedCard = cardStorage.getCard(url);
          if (cachedCard) {
            console.log("[Lianki] Using cached card");
            state.noteId = cachedCard.note._id;
            state.notes = cachedCard.note.notes ?? "";
            state.notesSynced = !cachedCard.dirty;
            state.phase = "reviewing";
            state.options = localFSRS.calculateOptions(cachedCard.note.card);
            renderDialog();
            if (navigator.onLine && cachedCard.dirty) {
              queueStorage.addToQueue("sync", { url }, cachedCard.hlc);
              tryBackgroundSync();
            }
            setTimeout(() => prefetchNextCachedCard(), 100);
            return;
          }
        } catch (err) {
          console.error("[Lianki] Cache check failed:", err);
        }
      }
      addNote(url, document.title).then(async (note) => {
        state.noteId = note._id;
        state.notes = note.notes ?? "";
        state.notesSynced = true;
        if (offlineReady) {
          try {
            cardStorage.setCard(url, note, null);
          } catch (err) {
            console.error("[Lianki] Failed to cache card:", err);
          }
        }
        getNextUrl().then((data) => {
          prefetchedNextUrl = data.url;
          if (data.url)
            prefetchNextPage(data.url);
        }).catch(() => {});
        if (note.options) {
          return { options: note.options };
        }
        if (offlineReady && localFSRS) {
          return { options: localFSRS.calculateOptions(note.card) };
        }
        return getOptions(note._id);
      }).then((data) => {
        state.phase = "reviewing";
        state.options = data.options;
        renderDialog();
      }).catch((err) => {
        if (offlineReady && (err?.status === 401 || String(err?.message).includes("401") || String(err?.message).toLowerCase().includes("unauthorized"))) {
          const localNote = {
            _id: "local:" + hashUrl(url),
            url,
            title: document.title,
            card: localFSRS.newCard(),
            notes: "",
            hlc: newHLC(deviceId, null)
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
    const _originalDoReview = doReview;
    doReview = async function doReviewOffline(rating) {
      if (state.phase !== "reviewing" || !state.noteId)
        return;
      const url = normalizeUrl(location.href);
      if (offlineReady) {
        try {
          const cachedCard = cardStorage.getCard(url);
          if (cachedCard && localFSRS) {
            console.log("[Lianki] Applying review locally");
            const reviewResult = localFSRS.applyReview(cachedCard.note.card, rating);
            cachedCard.note.card = reviewResult.card;
            cachedCard.note.log = cachedCard.note.log || [];
            cachedCard.note.log.push(reviewResult.log);
            const newHlc = newHLC(deviceId, cachedCard.hlc);
            cardStorage.setCard(url, cachedCard.note, newHlc, true);
            queueStorage.addToQueue("review", {
              url,
              noteId: state.noteId,
              rating
            }, newHlc);
            const opt = state.options.find((o) => Number(o.rating) === rating);
            await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);
            tryBackgroundSync();
            return;
          }
        } catch (err) {
          console.error("[Lianki] Local review failed:", err);
        }
      }
      try {
        const result = await submitReview(state.noteId, rating);
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
    function startBackgroundSync() {
      syncTimer = setInterval(() => {
        if (navigator.onLine && !syncInProgress) {
          tryBackgroundSync();
        }
      }, 30000);
      window.addEventListener("online", () => {
        console.log("[Lianki] Network online - starting sync");
        tryBackgroundSync();
      });
      setTimeout(() => tryBackgroundSync(), 5000);
    }
    async function tryBackgroundSync() {
      if (syncInProgress || !offlineReady)
        return;
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
        for (const item of queue) {
          try {
            await syncQueueItem(item);
            queueStorage.removeFromQueue(item.id);
            console.log(`[Lianki] Synced: ${item.action} ${item.data.url || item.data.noteId}`);
          } catch (err) {
            console.error(`[Lianki] Sync failed for ${item.id}:`, err);
            item.retries = (item.retries || 0) + 1;
            if (item.retries > 5) {
              console.warn(`[Lianki] Dropping ${item.id} after 5 retries`);
              queueStorage.removeFromQueue(item.id);
            } else {
              queueStorage.updateQueueItem(item.id, { retries: item.retries });
            }
          }
        }
        configStorage.updateLastSync(newHLC(deviceId, null));
        console.log("[Lianki] Sync complete");
      } finally {
        syncInProgress = false;
      }
    }
    async function syncQueueItem(item) {
      switch (item.action) {
        case "review":
          await api(`/api/fsrs/review/${item.data.rating}/?id=${encodeURIComponent(item.data.noteId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hlc: item.hlc })
          });
          break;
        case "add":
          await addNote(item.data.url, item.data.title);
          break;
        case "delete":
          await deleteNote(item.data.noteId);
          break;
        case "sync":
          await api(`/api/fsrs/get?url=${encodeURIComponent(item.data.url)}`);
          break;
      }
    }
    async function prefetchDueCards() {
      if (!offlineReady || !navigator.onLine)
        return;
      try {
        console.log("[Lianki] Prefetching due cards...");
        const response = await api("/api/fsrs/due?limit=20");
        const dueCards = response.cards || [];
        for (const note of dueCards) {
          try {
            const url = note.url;
            const existing = cardStorage.getCard(url);
            if (!existing || compareHLC(note.hlc, existing.hlc) > 0) {
              cardStorage.setCard(url, note, note.hlc || newHLC("server", null), false);
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
      if (!offlineReady)
        return;
      try {
        const dueCards = cardStorage.getDueCards(1);
        if (dueCards.length > 0 && dueCards[0].url !== location.href) {
          prefetchNextPage(dueCards[0].url);
        }
      } catch (err) {
        console.error("[Lianki] Failed to prefetch next cached card:", err);
      }
    }
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
})();
