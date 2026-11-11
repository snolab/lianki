// ==UserScript==
// @name        Lianki
// @name:en     Lianki LiCards
// @name:zh     链卡 Lianki
// @name:zh-CN  链卡 Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_info
// @grant       unsafeWindow
// @grant       GM_registerMenuCommand
// @version     2.24.33
// @author      lianki.com
// @description LiCards by Lianki: turn any web page into a spaced-repetition card and review it right on the page (Alt+F). Offline-first with IndexedDB sync. Press , or . (or media keys) to control video speed with difficulty markers.
// @description:zh    链卡（Lianki）：把任意网页变成间隔重复卡片，直接在网页上复习（Alt+F）。离线优先，IndexedDB 同步。按 , 或 .（或媒体键）调节视频速度，并标记难度。
// @description:zh-CN 链卡（Lianki）：把任意网页变成间隔重复卡片，直接在网页上复习（Alt+F）。离线优先，IndexedDB 同步。按 , 或 .（或媒体键）调节视频速度，并标记难度。
// @run-at      document-end
// @downloadURL https://lianki.com/lianki.user.js
// @updateURL   https://lianki.com/lianki.meta.js
// @connect     lianki.com
// @connect     www.lianki.com
// ==/UserScript==
(() => {
  // node_modules/.bun/ts-fsrs@5.2.3/node_modules/ts-fsrs/dist/index.mjs
  var State = /* @__PURE__ */ ((State2) => {
    State2[(State2["New"] = 0)] = "New";
    State2[(State2["Learning"] = 1)] = "Learning";
    State2[(State2["Review"] = 2)] = "Review";
    State2[(State2["Relearning"] = 3)] = "Relearning";
    return State2;
  })(State || {});
  var Rating = /* @__PURE__ */ ((Rating2) => {
    Rating2[(Rating2["Manual"] = 0)] = "Manual";
    Rating2[(Rating2["Again"] = 1)] = "Again";
    Rating2[(Rating2["Hard"] = 2)] = "Hard";
    Rating2[(Rating2["Good"] = 3)] = "Good";
    Rating2[(Rating2["Easy"] = 4)] = "Easy";
    return Rating2;
  })(Rating || {});

  class TypeConvert {
    static card(card) {
      return {
        ...card,
        state: TypeConvert.state(card.state),
        due: TypeConvert.time(card.due),
        last_review: card.last_review ? TypeConvert.time(card.last_review) : undefined,
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
      if (
        typeof value === "object" &&
        value !== null &&
        !Number.isNaN(Date.parse(value) || +date)
      ) {
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
        review: TypeConvert.time(log.review),
      };
    }
  }
  Date.prototype.scheduler = function (t, isDay) {
    return date_scheduler(this, t, isDay);
  };
  Date.prototype.diff = function (pre, unit) {
    return date_diff(this, pre, unit);
  };
  Date.prototype.format = function () {
    return formatDate(this);
  };
  Date.prototype.dueFormat = function (last_review, unit, timeUnit) {
    return show_diff_message(this, last_review, unit, timeUnit);
  };
  function date_scheduler(now, t, isDay) {
    return new Date(
      isDay
        ? TypeConvert.time(now).getTime() + t * 24 * 60 * 60 * 1000
        : TypeConvert.time(now).getTime() + t * 60 * 1000,
    );
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
    for (i = 0; i < TIMEUNIT.length; i++) {
      if (diff < TIMEUNIT[i]) {
        break;
      } else {
        diff /= TIMEUNIT[i];
      }
    }
    return `${Math.floor(diff)}${unit ? timeUnit[i] : ""}`;
  }
  var Grades = Object.freeze([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
  var FUZZ_RANGES = [
    {
      start: 2.5,
      end: 7,
      factor: 0.15,
    },
    {
      start: 7,
      end: 20,
      factor: 0.1,
    },
    {
      start: 20,
      end: Infinity,
      factor: 0.05,
    },
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
    const learning_steps =
      state === State.Relearning || state === State.Review
        ? params.relearning_steps
        : params.learning_steps;
    const steps_length = learning_steps.length;
    if (steps_length === 0 || cur_step >= steps_length) return {};
    const firstStep = learning_steps[0];
    const toMinutes = ConvertStepUnitToMinutes;
    const getAgainInterval = () => {
      return toMinutes(firstStep);
    };
    const getHardInterval = () => {
      if (steps_length === 1) return Math.round(toMinutes(firstStep) * 1.5);
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
        next_step: 0,
      };
      return result;
    } else {
      result[Rating.Again] = {
        scheduled_minutes: getAgainInterval(),
        next_step: 0,
      };
      result[Rating.Hard] = {
        scheduled_minutes: getHardInterval(),
        next_step: cur_step,
      };
      const next_info = getStepInfo(cur_step + 1);
      if (next_info) {
        const nextMin = getGoodMinutes(next_info);
        if (nextMin) {
          result[Rating.Good] = {
            scheduled_minutes: Math.round(nextMin),
            next_step: cur_step + 1,
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
    next = /* @__PURE__ */ new Map();
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
        [Symbol.iterator]: this.previewIterator.bind(this),
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
        review: this.review_time,
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
      if (seed == null) seed = Date.now();
      this.s0 -= mash(seed);
      if (this.s0 < 0) this.s0 += 1;
      this.s1 -= mash(seed);
      if (this.s1 < 0) this.s1 += 1;
      this.s2 -= mash(seed);
      if (this.s2 < 0) this.s2 += 1;
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
        s2: this.s2,
      };
    }
  }
  function Mash() {
    let n = 4022871197;
    return function mash(data) {
      data = String(data);
      for (let i = 0; i < data.length; i++) {
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
    prng.int32 = () => (xg.next() * 4294967296) | 0;
    prng.double = () => prng() + ((prng() * 2097152) | 0) * 0.00000000000000011102230246251565;
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
  var default_learning_steps = Object.freeze(["1m", "10m"]);
  var default_relearning_steps = Object.freeze(["10m"]);
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
    FSRS6_DEFAULT_DECAY,
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
    [enable_short_term ? 0.01 : 0, 0.8],
    [0.1, 0.8],
  ];
  var clipParameters = (
    parameters,
    numRelearningSteps,
    enableShortTerm = default_enable_short_term,
  ) => {
    let w17_w18_ceiling = W17_W18_Ceiling;
    if (Math.max(0, numRelearningSteps) > 1) {
      const value =
        -(
          Math.log(parameters[11]) +
          Math.log(Math.pow(2, parameters[13]) - 1) +
          parameters[14] * 0.3
        ) / numRelearningSteps;
      w17_w18_ceiling = clamp(+value.toFixed(8), 0.01, 2);
    }
    const clip = CLAMP_PARAMETERS(w17_w18_ceiling, enableShortTerm).slice(0, parameters.length);
    return clip.map(([min, max], index) => clamp(parameters[index] || 0, min, max));
  };
  var migrateParameters = (
    parameters,
    numRelearningSteps = 0,
    enableShortTerm = default_enable_short_term,
  ) => {
    if (parameters === undefined) {
      return [...default_w];
    }
    switch (parameters.length) {
      case 21:
        return clipParameters(Array.from(parameters), numRelearningSteps, enableShortTerm);
      case 19:
        console.debug("[FSRS-6]auto fill w from 19 to 21 length");
        return clipParameters(Array.from(parameters), numRelearningSteps, enableShortTerm).concat([
          0,
          FSRS5_DEFAULT_DECAY,
        ]);
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
    const learning_steps = Array.isArray(props?.learning_steps)
      ? props.learning_steps
      : default_learning_steps;
    const relearning_steps = Array.isArray(props?.relearning_steps)
      ? props.relearning_steps
      : default_relearning_steps;
    const enable_short_term = props?.enable_short_term ?? default_enable_short_term;
    const w = migrateParameters(props?.w, relearning_steps.length, enable_short_term);
    return {
      request_retention: props?.request_retention || default_request_retention,
      maximum_interval: props?.maximum_interval || default_maximum_interval,
      w,
      enable_fuzz: props?.enable_fuzz ?? default_enable_fuzz,
      enable_short_term,
      learning_steps,
      relearning_steps,
    };
  };
  function createEmptyCard(now, afterHandler) {
    const emptyCard = {
      due: now ? TypeConvert.time(now) : /* @__PURE__ */ new Date(),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      learning_steps: 0,
      state: State.New,
      last_review: undefined,
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
    return +Math.pow(1 + (factor * elapsed_days) / stability, decay).toFixed(8);
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
        set: function (target, prop, value) {
          if (prop === "request_retention" && Number.isFinite(value)) {
            _this.intervalModifier = _this.calculate_interval_modifier(Number(value));
          } else if (prop === "w") {
            value = migrateParameters(
              value,
              target.relearning_steps.length,
              target.enable_short_term,
            );
            _this.forgetting_curve = forgetting_curve.bind(this, value);
            _this.intervalModifier = _this.calculate_interval_modifier(
              Number(target.request_retention),
            );
          }
          Reflect.set(target, prop, value);
          return true;
        },
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
      if (!this.param.enable_fuzz || ivl < 2.5) return Math.round(ivl);
      const generator = alea(this._seed);
      const fuzz_factor = generator();
      const { min_ivl, max_ivl } = get_fuzz_range(ivl, elapsed_days, this.param.maximum_interval);
      return Math.floor(fuzz_factor * (max_ivl - min_ivl + 1) + min_ivl);
    }
    next_interval(s, elapsed_days) {
      const newInterval = Math.min(
        Math.max(1, Math.round(s * this.intervalModifier)),
        this.param.maximum_interval,
      );
      return this.apply_fuzz(newInterval, elapsed_days);
    }
    linear_damping(delta_d, old_d) {
      return +((delta_d * (10 - old_d)) / 9).toFixed(8);
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
      return +clamp(
        s *
          (1 +
            Math.exp(this.param.w[8]) *
              (11 - d) *
              Math.pow(s, -this.param.w[9]) *
              (Math.exp((1 - r) * this.param.w[10]) - 1) *
              hard_penalty *
              easy_bound),
        S_MIN,
        36500,
      ).toFixed(8);
    }
    next_forget_stability(d, s, r) {
      return +clamp(
        this.param.w[11] *
          Math.pow(d, -this.param.w[12]) *
          (Math.pow(s + 1, this.param.w[13]) - 1) *
          Math.exp((1 - r) * this.param.w[14]),
        S_MIN,
        36500,
      ).toFixed(8);
    }
    next_short_term_stability(s, g) {
      const sinc =
        Math.pow(s, -this.param.w[19]) * Math.exp(this.param.w[17] * (g - 3 + this.param.w[18]));
      const maskedSinc = g >= 3 ? Math.max(sinc, 1) : sinc;
      return +clamp(s * maskedSinc, S_MIN, 36500).toFixed(8);
    }
    forgetting_curve;
    next_state(memory_state, t, g) {
      const { difficulty: d, stability: s } = memory_state ?? {
        difficulty: 0,
        stability: 0,
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
          stability: this.init_stability(g),
        };
      }
      if (g === 0) {
        return {
          difficulty: d,
          stability: s,
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
      const steps_strategy = this.learningStepsStrategy(
        parameters,
        card.state,
        this.current.state === State.Learning && grade !== Rating.Again && grade !== Rating.Hard
          ? card.learning_steps + 1
          : card.learning_steps,
      );
      const scheduled_minutes = Math.max(0, steps_strategy[grade]?.scheduled_minutes ?? 0);
      const next_steps = Math.max(0, steps_strategy[grade]?.next_step ?? 0);
      return {
        scheduled_minutes,
        next_steps,
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
        log: this.buildLog(grade),
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
        log: this.buildLog(grade),
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
      this.next_ds(
        next_again,
        next_hard,
        next_good,
        next_easy,
        difficulty,
        stability,
        retrievability,
      );
      this.next_interval(next_hard, next_good, next_easy, interval);
      this.next_state(next_hard, next_good, next_easy);
      this.applyLearningSteps(next_again, Rating.Again, State.Relearning);
      next_again.lapses += 1;
      const item_again = {
        card: next_again,
        log: this.buildLog(Rating.Again),
      };
      const item_hard = {
        card: next_hard,
        log: super.buildLog(Rating.Hard),
      };
      const item_good = {
        card: next_good,
        log: super.buildLog(Rating.Good),
      };
      const item_easy = {
        card: next_easy,
        log: super.buildLog(Rating.Easy),
      };
      this.next.set(Rating.Again, item_again);
      this.next.set(Rating.Hard, item_hard);
      this.next.set(Rating.Good, item_good);
      this.next.set(Rating.Easy, item_easy);
      return this.next.get(grade);
    }
    next_ds(next_again, next_hard, next_good, next_easy, difficulty, stability, retrievability) {
      next_again.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Again);
      const nextSMin =
        stability / Math.exp(this.algorithm.parameters.w[17] * this.algorithm.parameters.w[18]);
      const s_after_fail = this.algorithm.next_forget_stability(
        difficulty,
        stability,
        retrievability,
      );
      next_again.stability = clamp(+nextSMin.toFixed(8), S_MIN, s_after_fail);
      next_hard.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Hard);
      next_hard.stability = this.algorithm.next_recall_stability(
        difficulty,
        stability,
        retrievability,
        Rating.Hard,
      );
      next_good.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Good);
      next_good.stability = this.algorithm.next_recall_stability(
        difficulty,
        stability,
        retrievability,
        Rating.Good,
      );
      next_easy.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Easy);
      next_easy.stability = this.algorithm.next_recall_stability(
        difficulty,
        stability,
        retrievability,
        Rating.Easy,
      );
    }
    next_interval(next_hard, next_good, next_easy, interval) {
      let hard_interval, good_interval;
      hard_interval = this.algorithm.next_interval(next_hard.stability, interval);
      good_interval = this.algorithm.next_interval(next_good.stability, interval);
      hard_interval = Math.min(hard_interval, good_interval);
      good_interval = Math.max(good_interval, hard_interval + 1);
      const easy_interval = Math.max(
        this.algorithm.next_interval(next_easy.stability, interval),
        good_interval + 1,
      );
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
      this.next_ds(
        next_again,
        next_hard,
        next_good,
        next_easy,
        difficulty,
        stability,
        retrievability,
      );
      this.next_interval(next_again, next_hard, next_good, next_easy, interval);
      this.next_state(next_again, next_hard, next_good, next_easy);
      next_again.lapses += 1;
      this.update_next(next_again, next_hard, next_good, next_easy);
      return this.next.get(grade);
    }
    next_ds(next_again, next_hard, next_good, next_easy, difficulty, stability, retrievability) {
      next_again.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Again);
      const s_after_fail = this.algorithm.next_forget_stability(
        difficulty,
        stability,
        retrievability,
      );
      next_again.stability = clamp(stability, S_MIN, s_after_fail);
      next_hard.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Hard);
      next_hard.stability = this.algorithm.next_recall_stability(
        difficulty,
        stability,
        retrievability,
        Rating.Hard,
      );
      next_good.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Good);
      next_good.stability = this.algorithm.next_recall_stability(
        difficulty,
        stability,
        retrievability,
        Rating.Good,
      );
      next_easy.difficulty = this.algorithm.next_difficulty(difficulty, Rating.Easy);
      next_easy.stability = this.algorithm.next_recall_stability(
        difficulty,
        stability,
        retrievability,
        Rating.Easy,
      );
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
        log: this.buildLog(Rating.Again),
      };
      const item_hard = {
        card: next_hard,
        log: super.buildLog(Rating.Hard),
      };
      const item_good = {
        card: next_good,
        log: super.buildLog(Rating.Good),
      };
      const item_easy = {
        card: next_easy,
        log: super.buildLog(Rating.Easy),
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
          review: reviewed,
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
          review: reviewed,
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
          reps: card.reps + 1,
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
          item = this.handleManualRating(
            cur_card,
            review.state,
            review.review,
            interval,
            review.stability,
            review.difficulty,
            review.due ? TypeConvert.time(review.due) : undefined,
          );
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
      return this.handleManualRating(
        cur_card,
        reschedule_card.state,
        TypeConvert.time(now),
        log.elapsed_days,
        update_memory ? reschedule_card.stability : undefined,
        update_memory ? reschedule_card.difficulty : undefined,
        reschedule_card.due,
      );
    }
  }

  class FSRS extends FSRSAlgorithm {
    strategyHandler = /* @__PURE__ */ new Map();
    Scheduler;
    constructor(param) {
      super(param);
      const { enable_short_term } = this.parameters;
      this.Scheduler = enable_short_term ? BasicScheduler : LongTermScheduler;
    }
    params_handler_proxy() {
      const _this = this;
      return {
        set: function (target, prop, value) {
          if (prop === "request_retention" && Number.isFinite(value)) {
            _this.intervalModifier = _this.calculate_interval_modifier(Number(value));
          } else if (prop === "enable_short_term") {
            _this.Scheduler = value === true ? BasicScheduler : LongTermScheduler;
          } else if (prop === "w") {
            value = migrateParameters(
              value,
              target.relearning_steps.length,
              target.enable_short_term,
            );
            _this.forgetting_curve = forgetting_curve.bind(this, value);
            _this.intervalModifier = _this.calculate_interval_modifier(
              Number(target.request_retention),
            );
          }
          Reflect.set(target, prop, value);
          return true;
        },
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
      now = now ? TypeConvert.time(now) : /* @__PURE__ */ new Date();
      const t =
        processedCard.state !== State.New
          ? Math.max(date_diff(now, processedCard.last_review, "days"), 0)
          : 0;
      const r =
        processedCard.state !== State.New
          ? this.forgetting_curve(t, +processedCard.stability.toFixed(8))
          : 0;
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
          last_lapses =
            processedCard.lapses -
            (processedLog.rating === Rating.Again && processedLog.state === State.Review ? 1 : 0);
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
        last_review,
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
      const scheduled_days =
        processedCard.state === State.New ? 0 : date_diff(now, processedCard.due, "days");
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
        review: now,
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
        last_review: processedCard.last_review,
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
        now = /* @__PURE__ */ new Date(),
        update_memory_state: updateMemoryState = false,
      } = options;
      if (reviewsOrderBy && typeof reviewsOrderBy === "function") {
        reviews.sort(reviewsOrderBy);
      }
      if (skipManual) {
        reviews = reviews.filter((review) => review.rating !== Rating.Manual);
      }
      const rescheduleSvc = new Reschedule(this);
      const collections = rescheduleSvc.reschedule(
        options.first_card || createEmptyCard(),
        reviews,
      );
      const len = collections.length;
      const cur_card = TypeConvert.card(current_card);
      const manual_item = rescheduleSvc.calculateManualRecord(
        cur_card,
        now,
        len ? collections[len - 1] : undefined,
        updateMemoryState,
      );
      if (recordLogHandler && typeof recordLogHandler === "function") {
        return {
          collections: collections.map(recordLogHandler),
          reschedule_item: manual_item ? recordLogHandler(manual_item) : null,
        };
      }
      return {
        collections,
        reschedule_item: manual_item,
      };
    }
  }
  var fsrs = (params) => {
    return new FSRS(params || {});
  };

  // packages/core/src/watchStats.ts
  var COV_BUCKET_S = 5;
  var COV_MAX_BUCKETS = 4096;
  var emptyWatchStats = () => ({ v: 1, by: {} });
  var localDayKey = (d = new Date()) => d.toLocaleDateString("en-CA");
  function coverageBuckets(durSeconds) {
    if (durSeconds == null || !Number.isFinite(durSeconds) || durSeconds <= 0) return 0;
    const n = Math.ceil(durSeconds / COV_BUCKET_S);
    return n > COV_MAX_BUCKETS ? 0 : n;
  }
  var newCoverage = (buckets) => new Uint8Array(Math.ceil(buckets / 8));
  function markCoverage(bytes, fromS, toS) {
    const buckets = bytes.length * 8;
    if (!buckets) return;
    const a = Math.min(fromS, toS);
    const b = Math.max(fromS, toS);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    const lo = Math.max(0, Math.floor(a / COV_BUCKET_S));
    const hi = Math.min(buckets - 1, Math.floor(b / COV_BUCKET_S));
    for (let i = lo; i <= hi; i++) bytes[i >> 3] |= 1 << (i & 7);
  }
  function encodeCoverage(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1024)
      bin += String.fromCharCode(...bytes.subarray(i, i + 1024));
    return btoa(bin);
  }
  function decodeCoverage(b64) {
    if (!b64) return new Uint8Array(0);
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return new Uint8Array(0);
    }
  }
  function mergeCoverage(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x = decodeCoverage(a);
    const y = decodeCoverage(b);
    const out = new Uint8Array(Math.max(x.length, y.length));
    out.set(x);
    for (let i = 0; i < y.length; i++) out[i] |= y[i];
    return encodeCoverage(out);
  }
  var maxNum = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
  var minStr = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
  var maxStr = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);
  function mergeLang(a, b) {
    if (!a.lang || !b.lang || a.lang === b.lang) return a.lang ?? b.lang;
    const al = a.last ?? "";
    const bl = b.last ?? "";
    if (al !== bl) return al > bl ? a.lang : b.lang;
    return a.lang < b.lang ? a.lang : b.lang;
  }
  function mergeDeviceWatch(a, b) {
    const days = { ...a.days };
    for (const [day, secs] of Object.entries(b.days ?? {}))
      days[day] = Math.max(days[day] ?? 0, secs);
    return {
      wall: Math.max(a.wall, b.wall),
      media: Math.max(a.media, b.media),
      sessions: Math.max(a.sessions, b.sessions),
      days,
      cov: mergeCoverage(a.cov, b.cov),
      dur: maxNum(a.dur, b.dur),
      lang: mergeLang(a, b),
      first: minStr(a.first, b.first),
      last: maxStr(a.last, b.last),
    };
  }
  function mergeWatchStats(a, b) {
    const out = { v: 1, by: { ...a?.by } };
    for (const [device, watch] of Object.entries(b?.by ?? {})) {
      const mine = out.by[device];
      out.by[device] = mine ? mergeDeviceWatch(mine, watch) : watch;
    }
    return out;
  }
  var MAX_DEVICES = 32;
  var MAX_DAYS = 400;
  var MAX_COV_CHARS = 700;
  var MAX_SECONDS = 1e9;
  var DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
  var num = (v, max) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : undefined;
  var str = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
  function sanitizeWatchStats(input) {
    const by = input?.by;
    if (!by || typeof by !== "object") return emptyWatchStats();
    const out = emptyWatchStats();
    for (const [device, raw] of Object.entries(by).slice(0, MAX_DEVICES)) {
      if (device.length > 64 || !raw || typeof raw !== "object") continue;
      const d = raw;
      const days = {};
      for (const [day, secs] of Object.entries(d.days ?? {}).slice(0, MAX_DAYS)) {
        if (!DAY_KEY.test(day)) continue;
        const v = num(secs, 86400);
        if (v != null) days[day] = v;
      }
      const cov = str(d.cov, MAX_COV_CHARS);
      out.by[device] = {
        wall: num(d.wall, MAX_SECONDS) ?? 0,
        media: num(d.media, MAX_SECONDS) ?? 0,
        sessions: num(d.sessions, 1e6) ?? 0,
        days,
        cov: cov && /^[A-Za-z0-9+/=]*$/.test(cov) ? cov : undefined,
        dur: num(d.dur, MAX_SECONDS),
        lang: str(d.lang, 32),
        first: str(d.first, 32),
        last: str(d.last, 32),
      };
    }
    return out;
  }

  // packages/core/src/difficulty.ts
  var RATE_FLOOR = 0.5;
  var RATE_CEIL = 2;
  function rateSegments(markers, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return [];
    const points = Object.entries(markers ?? {})
      .map(([t, rate]) => ({ t: Number(t), rate: Number(rate) }))
      .filter((p) => Number.isFinite(p.t) && p.t >= 0 && Number.isFinite(p.rate) && p.rate > 0)
      .sort((a, b) => a.t - b.t);
    const segments = [];
    let cursor = 0;
    let rate = 1;
    for (const p of points) {
      if (p.t >= duration) break;
      if (p.t > cursor) segments.push({ from: cursor, to: p.t, rate });
      cursor = p.t;
      rate = p.rate;
    }
    if (cursor < duration) segments.push({ from: cursor, to: duration, rate });
    return segments.filter((s) => s.to > s.from);
  }
  function maturityScore(segments) {
    let total = 0;
    let sumLog = 0;
    for (const s of segments) {
      const span = s.to - s.from;
      if (span <= 0) continue;
      total += span;
      sumLog += Math.log(clampRate(s.rate)) * span;
    }
    return total > 0 ? Math.exp(sumLog / total) : 1;
  }
  var clampRate = (rate) =>
    Math.min(RATE_CEIL, Math.max(RATE_FLOOR, Number.isFinite(rate) && rate > 0 ? rate : 1));
  function heatmapBuckets(segments, duration, count) {
    if (!Number.isFinite(duration) || duration <= 0 || count <= 0) return [];
    const width = duration / count;
    const out = [];
    for (let i = 0; i < count; i++) {
      const lo = i * width;
      const hi = lo + width;
      let span = 0;
      let sumLog = 0;
      for (const s of segments) {
        const overlap = Math.min(hi, s.to) - Math.max(lo, s.from);
        if (overlap <= 0) continue;
        span += overlap;
        sumLog += Math.log(clampRate(s.rate)) * overlap;
      }
      out.push(span > 0 ? Math.exp(sumLog / span) : 1);
    }
    return out;
  }
  function rateColor(rate, alpha = 1) {
    const x = Math.log2(clampRate(rate));
    if (Math.abs(x) < 0.05) return `oklch(0.72 0.012 250 / ${alpha})`;
    const mag = Math.min(1, Math.abs(x));
    const hue = x > 0 ? 148 : 27;
    const chroma = (0.06 + mag * 0.11).toFixed(3);
    const light = (0.68 - mag * 0.08).toFixed(3);
    return `oklch(${light} ${chroma} ${hue} / ${alpha})`;
  }
  function maturityLabel(score) {
    if (score >= 1.25) return "comfortable";
    if (score >= 1.05) return "easy";
    if (score > 0.95) return "steady";
    if (score > 0.8) return "effortful";
    return "hard";
  }
  function videoDifficulty(markers, duration) {
    const segments = rateSegments(markers, duration);
    const markedSpan = segments
      .filter((s) => Math.abs(s.rate - 1) > 0.01)
      .reduce((sum, s) => sum + (s.to - s.from), 0);
    const score = maturityScore(segments);
    return {
      score,
      label: maturityLabel(score),
      marked: duration > 0 ? Math.min(1, markedSpan / duration) : 0,
      segments,
    };
  }

  // packages/core/src/duePrune.ts
  function dueWindow(dueMs, pageSize, limit) {
    const finite = dueMs.filter((d) => Number.isFinite(d));
    return {
      lo: finite.length ? Math.min(...finite) : Infinity,
      hi: finite.length ? Math.max(...finite) : -Infinity,
      truncated: pageSize >= limit,
    };
  }
  function isProvablyDeleted(dueMs, w) {
    if (!Number.isFinite(dueMs)) return false;
    if (!w.truncated) return true;
    return dueMs > w.lo && dueMs < w.hi;
  }

  // packages/core/src/titleClean.ts
  var TITLE_PATTERN_MAX = 48;
  var TITLE_HOST_MAX = 40;
  var TITLE_RULES_ADD_MAX = 10;
  var TITLE_RULES_OFF_MAX = 64;
  var WINDOW = 512;
  var ANY_MAX = 64;
  var ANY_PER_PATTERN = 3;
  var PASSES = 3;
  var RULES_MAX = 128;
  var on = (host, ...patterns) => patterns.map((pattern) => ({ host, pattern }));
  var COUNTING_SITES = [
    "youtube.com",
    "instagram.com",
    "linkedin.com",
    "reddit.com",
    "discord.com",
    "quora.com",
    "twitch.tv",
    "tiktok.com",
    "pinterest.com",
    "threads.net",
    "web.whatsapp.com",
    "web.telegram.org",
  ];
  var DEFAULT_TITLE_RULES = [
    ...on(
      "",
      "(9+)",
      "(99+)",
      "(999+)",
      "(## new)",
      "(## unread)",
      "(## message)",
      "(## messages)",
      "(## new message)",
      "(## new messages)",
      "(## notification)",
      "(## notifications)",
      "(## 条消息)",
      "(## 条新消息)",
      "(## 条未读)",
      "(## 条通知)",
      "(## 条私信)",
      "(## 封私信)",
      "(## 件の通知)",
      "(## 件の新着)",
      "(## 개의 알림)",
    ),
    ...on("zhihu.com", "(##*条消息)", "(##*封私信)"),
    ...COUNTING_SITES.flatMap((host) => on(host, "(#)")),
    ...on("facebook.com", "(#)", "(#+)"),
    ...on("x.com", "(#)", "(#+)"),
    ...on("twitter.com", "(#)", "(#+)"),
  ];
  function titleRuleId(rule) {
    const s = `${rule.host}|${rule.pattern}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  var isSpace = (c) =>
    c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 12288 || c === 8203 || c === 65279;
  var isDigit = (c) => c >= 48 && c <= 57;
  function fold(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 65281 && c <= 65374) {
        const ascii = String.fromCharCode(c - 65248).toLowerCase();
        out += ascii;
      } else if (c === 12304 || c === 12308) out += "[";
      else if (c === 12305 || c === 12309) out += "]";
      else {
        const ch = s[i];
        const lower = ch.toLowerCase();
        out += lower.length === 1 ? lower : ch;
      }
    }
    return out;
  }
  function compile(pattern) {
    if (typeof pattern !== "string" || pattern.length > TITLE_PATTERN_MAX) return null;
    if (/:\/\/|^\/\/|\.ts\.net|localhost|127\.0\.0\.1/i.test(pattern)) return null;
    const tokens = [];
    let lit = "";
    const flush = () => {
      if (lit) tokens.push({ k: "lit", s: fold(lit) });
      lit = "";
    };
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "\\") {
        i++;
        if (i >= pattern.length) return null;
        lit += pattern[i];
      } else if (ch === "#") {
        flush();
        if (pattern[i + 1] === "#") {
          i++;
          tokens.push({ k: "num", max: 4, plus: true });
        } else tokens.push({ k: "num", max: 2, plus: false });
      } else if (ch === "*") {
        flush();
        tokens.push({ k: "any" });
      } else if (isSpace(pattern.charCodeAt(i))) {
        flush();
        tokens.push({ k: "space" });
      } else lit += ch;
    }
    flush();
    while (tokens[0]?.k === "space") tokens.shift();
    while (tokens[tokens.length - 1]?.k === "space") tokens.pop();
    if (!tokens.length || tokens[0].k === "any") return null;
    if (tokens.filter((t) => t.k === "any").length > ANY_PER_PATTERN) return null;
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      out.push(t);
      if (t.k !== "any") continue;
      while (tokens[i + 1]?.k === "space") i++;
      if (tokens[i + 1]?.k !== "lit") return null;
    }
    return out;
  }
  var isTitlePattern = (pattern) => compile(pattern) !== null;
  function titleHostOf(input) {
    if (typeof input !== "string") return null;
    const raw = input.trim().toLowerCase();
    if (!raw) return null;
    let host;
    try {
      host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
    } catch {
      return null;
    }
    host = host.replace(/^www\./, "");
    if (host.length > TITLE_HOST_MAX) return null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
    if (/\.ts\.net$|\.local$|\.internal$|\.\d+$/.test(host)) return null;
    return host;
  }
  var isTitleHost = (host) =>
    host === "" || (typeof host === "string" && titleHostOf(host) === host);
  function matchAt(tokens, text, from) {
    let i = from;
    for (let n = 0; n < tokens.length; n++) {
      const t = tokens[n];
      if (t.k === "lit") {
        if (!text.startsWith(t.s, i)) return -1;
        i += t.s.length;
      } else if (t.k === "space") {
        while (i < text.length && isSpace(text.charCodeAt(i))) i++;
      } else if (t.k === "num") {
        const start = i;
        while (i < text.length && isDigit(text.charCodeAt(i))) {
          i++;
          if (i - start > t.max) return -1;
        }
        if (i === start) return -1;
        if (t.plus && text[i] === "+") i++;
      } else {
        const next = tokens[n + 1].s;
        const limit = Math.min(i + ANY_MAX, text.length);
        let found = -1;
        for (let j = i; j <= limit; j++) {
          if (text.startsWith(next, j)) {
            found = j;
            break;
          }
          const c = text[j];
          if (
            c === ")" ||
            c === "]" ||
            c ===
              `
`
          )
            return -1;
        }
        if (found < 0) return -1;
        i = found;
      }
    }
    return i;
  }
  var compiledOf = new WeakMap();
  function compileRules(rules) {
    let c = compiledOf.get(rules);
    if (c) return c;
    c = [];
    for (const r of rules.slice(0, RULES_MAX)) {
      const tokens = compile(r?.pattern);
      if (tokens) c.push({ host: typeof r.host === "string" ? r.host : "", tokens });
    }
    compiledOf.set(rules, c);
    return c;
  }
  function hostFromUrl(url) {
    if (!url) return "";
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  var onHost = (ruleHost, host) =>
    ruleHost === "" || host === ruleHost || host.endsWith(`.${ruleHost}`);
  var hasWords = (s) => /[\p{L}\p{N}]/u.test(s);
  function cleanTitle(title, opts = {}) {
    if (typeof title !== "string" || !title) return title;
    const rules = opts.rules ?? DEFAULT_TITLE_RULES;
    const host = hostFromUrl(opts.url);
    const usable = compileRules(rules).filter((r) => onHost(r.host, host));
    if (!usable.length) return title;
    const text = fold(title.slice(0, WINDOW));
    const skipSpace = (i) => {
      while (i < text.length && isSpace(text.charCodeAt(i))) i++;
      return i;
    };
    let at = skipSpace(0);
    let cut = -1;
    for (let pass = 0; pass < PASSES; pass++) {
      let end = -1;
      for (const r of usable) {
        end = matchAt(r.tokens, text, at);
        if (end >= 0) break;
      }
      if (end < 0) break;
      at = skipSpace(end);
      cut = at;
    }
    if (cut < 0) return title;
    const rest = title.slice(cut);
    return hasWords(rest) ? rest : title;
  }
  var BARE_COUNT = compile("(##)");
  function parseTitleRulesPref(v) {
    const o = v && typeof v === "object" ? v : {};
    const off = (Array.isArray(o.off) ? o.off : [])
      .filter((id) => typeof id === "string" && /^[0-9a-f]{8}$/.test(id))
      .slice(0, TITLE_RULES_OFF_MAX);
    const add = (Array.isArray(o.add) ? o.add : [])
      .filter((r) => !!r && isTitleHost(r.host) && isTitlePattern(r.pattern))
      .slice(0, TITLE_RULES_ADD_MAX)
      .map((r) => ({ host: r.host, pattern: r.pattern }));
    return { off, add };
  }
  var activeOf = new WeakMap();
  function activeTitleRules(pref) {
    if (!pref || typeof pref !== "object") return DEFAULT_TITLE_RULES;
    const memo = activeOf.get(pref);
    if (memo) return memo;
    const { off, add } = parseTitleRulesPref(pref);
    const rules =
      !off.length && !add.length
        ? DEFAULT_TITLE_RULES
        : [...DEFAULT_TITLE_RULES.filter((r) => !off.includes(titleRuleId(r))), ...add];
    activeOf.set(pref, rules);
    return rules;
  }

  // lib/read/gdoc-tail.ts
  var OP = /\{"ty":"is","ibi":(\d+),"s":"((?:[^"\\]|\\.)*)"\}|\{"ty":"ds","si":(\d+),"ei":(\d+)\}/g;
  function parseBindOps(chunk) {
    const ops = [];
    let consumed = 0;
    for (const m of chunk.matchAll(OP)) {
      consumed = (m.index ?? 0) + m[0].length;
      if (m[1] === undefined) {
        ops.push({ si: Number(m[3]), ei: Number(m[4]) });
        continue;
      }
      try {
        ops.push({ i: Number(m[1]), s: JSON.parse(`"${m[2]}"`) });
      } catch {}
    }
    return { ops, consumed };
  }

  // src/pill-chat-strings.ts
  var PILL_CHAT_LOCALES = [
    "en",
    "zh",
    "hi",
    "es",
    "fr",
    "ar",
    "bn",
    "pt",
    "ru",
    "ur",
    "id",
    "de",
    "ja",
    "sw",
    "mr",
    "ko",
  ];
  var PILL_CHAT_STRINGS = {
    en: {
      liTitle: "Chat with Li",
      promptTitle: "Allow Li chat on {host}?",
      promptBody:
        "Li runs in its own window from lianki.com. This site cannot read what you type there. Li does not see this page unless you share something.",
      promptWarn: "Li can make mistakes. Do not paste passwords or private data from this page.",
      allowOnce: "Allow once",
      allowAlways: "Always on this site",
      neverHere: "Never on this site",
      notNow: "Not now",
      sitesTitle: "Li chat: sites",
      sitesMenu: "Li chat: sites…",
      sitesEmpty: "No sites yet.",
      sitesAllowed: "Allowed",
      sitesNever: "Never",
      forget: "Forget",
      close: "Close",
      blocked: "This site blocks Li's private window, so Li cannot open here.",
      openLianki: "Chat on lianki.com",
    },
    zh: {
      liTitle: "和 Li 聊天",
      promptTitle: "允许在 {host} 上使用 Li 聊天吗？",
      promptBody:
        "Li 在来自 lianki.com 的独立窗口里运行。这个网站读不到你在里面输入的内容。除非你主动分享，Li 也看不到这个页面。",
      promptWarn: "Li 可能会出错。不要把这个页面上的密码或私人信息粘贴进来。",
      allowOnce: "仅这一次",
      allowAlways: "在此网站总是允许",
      neverHere: "在此网站永不允许",
      notNow: "暂不",
      sitesTitle: "Li 聊天：网站",
      sitesMenu: "Li 聊天：网站…",
      sitesEmpty: "还没有任何网站。",
      sitesAllowed: "已允许",
      sitesNever: "永不",
      forget: "移除",
      close: "关闭",
      blocked: "这个网站阻止了 Li 的独立窗口，Li 无法在这里打开。",
      openLianki: "去 lianki.com 聊天",
    },
    hi: {
      liTitle: "Li से चैट करें",
      promptTitle: "{host} पर Li चैट की अनुमति दें?",
      promptBody:
        "Li, lianki.com की अपनी अलग विंडो में चलता है। यह साइट वहाँ आपके द्वारा लिखी गई बातें नहीं पढ़ सकती। जब तक आप कुछ साझा न करें, Li यह पेज नहीं देखता।",
      promptWarn: "Li से गलतियाँ हो सकती हैं। इस पेज से पासवर्ड या निजी जानकारी यहाँ पेस्ट न करें।",
      allowOnce: "एक बार अनुमति दें",
      allowAlways: "इस साइट पर हमेशा",
      neverHere: "इस साइट पर कभी नहीं",
      notNow: "अभी नहीं",
      sitesTitle: "Li चैट: साइटें",
      sitesMenu: "Li चैट: साइटें…",
      sitesEmpty: "अभी कोई साइट नहीं।",
      sitesAllowed: "अनुमति है",
      sitesNever: "कभी नहीं",
      forget: "हटाएँ",
      close: "बंद करें",
      blocked: "यह साइट Li की निजी विंडो को रोकती है, इसलिए Li यहाँ नहीं खुल सकता।",
      openLianki: "lianki.com पर चैट करें",
    },
    es: {
      liTitle: "Chatear con Li",
      promptTitle: "¿Permitir el chat de Li en {host}?",
      promptBody:
        "Li funciona en su propia ventana de lianki.com. Este sitio no puede leer lo que escribes ahí. Li no ve esta página a menos que compartas algo.",
      promptWarn: "Li puede equivocarse. No pegues contraseñas ni datos privados de esta página.",
      allowOnce: "Permitir una vez",
      allowAlways: "Siempre en este sitio",
      neverHere: "Nunca en este sitio",
      notNow: "Ahora no",
      sitesTitle: "Chat de Li: sitios",
      sitesMenu: "Chat de Li: sitios…",
      sitesEmpty: "Todavía no hay sitios.",
      sitesAllowed: "Permitido",
      sitesNever: "Nunca",
      forget: "Olvidar",
      close: "Cerrar",
      blocked: "Este sitio bloquea la ventana privada de Li, así que Li no puede abrirse aquí.",
      openLianki: "Chatear en lianki.com",
    },
    fr: {
      liTitle: "Discuter avec Li",
      promptTitle: "Autoriser le chat Li sur {host} ?",
      promptBody:
        "Li fonctionne dans sa propre fenêtre servie par lianki.com. Ce site ne peut pas lire ce que vous y tapez. Li ne voit pas cette page, sauf si vous partagez quelque chose.",
      promptWarn:
        "Li peut se tromper. Ne collez pas de mots de passe ni de données privées de cette page.",
      allowOnce: "Autoriser une fois",
      allowAlways: "Toujours sur ce site",
      neverHere: "Jamais sur ce site",
      notNow: "Pas maintenant",
      sitesTitle: "Chat Li : sites",
      sitesMenu: "Chat Li : sites…",
      sitesEmpty: "Aucun site pour l’instant.",
      sitesAllowed: "Autorisé",
      sitesNever: "Jamais",
      forget: "Oublier",
      close: "Fermer",
      blocked: "Ce site bloque la fenêtre privée de Li : Li ne peut pas s’ouvrir ici.",
      openLianki: "Discuter sur lianki.com",
    },
    ar: {
      liTitle: "الدردشة مع Li",
      promptTitle: "هل تسمح بدردشة Li على {host}؟",
      promptBody:
        "يعمل Li في نافذته الخاصة من lianki.com. لا يستطيع هذا الموقع قراءة ما تكتبه هناك. ولا يرى Li هذه الصفحة إلا إذا شاركت شيئًا منها.",
      promptWarn: "قد يخطئ Li. لا تلصق كلمات مرور أو بيانات خاصة من هذه الصفحة.",
      allowOnce: "السماح مرة واحدة",
      allowAlways: "دائمًا على هذا الموقع",
      neverHere: "أبدًا على هذا الموقع",
      notNow: "ليس الآن",
      sitesTitle: "دردشة Li: المواقع",
      sitesMenu: "دردشة Li: المواقع…",
      sitesEmpty: "لا توجد مواقع بعد.",
      sitesAllowed: "مسموح",
      sitesNever: "أبدًا",
      forget: "إزالة",
      close: "إغلاق",
      blocked: "يحظر هذا الموقع نافذة Li الخاصة، لذا لا يمكن فتح Li هنا.",
      openLianki: "الدردشة على lianki.com",
    },
    bn: {
      liTitle: "Li-এর সঙ্গে চ্যাট করুন",
      promptTitle: "{host}-এ Li চ্যাটের অনুমতি দেবেন?",
      promptBody:
        "Li চলে lianki.com-এর নিজস্ব আলাদা উইন্ডোতে। আপনি সেখানে যা লেখেন, এই সাইট তা পড়তে পারে না। আপনি কিছু শেয়ার না করলে Li এই পেজ দেখে না।",
      promptWarn: "Li ভুল করতে পারে। এই পেজ থেকে পাসওয়ার্ড বা ব্যক্তিগত তথ্য এখানে পেস্ট করবেন না।",
      allowOnce: "একবার অনুমতি দিন",
      allowAlways: "এই সাইটে সবসময়",
      neverHere: "এই সাইটে কখনো না",
      notNow: "এখন না",
      sitesTitle: "Li চ্যাট: সাইট",
      sitesMenu: "Li চ্যাট: সাইট…",
      sitesEmpty: "এখনো কোনো সাইট নেই।",
      sitesAllowed: "অনুমতি আছে",
      sitesNever: "কখনো না",
      forget: "সরান",
      close: "বন্ধ করুন",
      blocked: "এই সাইট Li-এর ব্যক্তিগত উইন্ডো আটকে দেয়, তাই Li এখানে খোলা যায় না।",
      openLianki: "lianki.com-এ চ্যাট করুন",
    },
    pt: {
      liTitle: "Conversar com Li",
      promptTitle: "Permitir o chat do Li em {host}?",
      promptBody:
        "O Li funciona em sua própria janela do lianki.com. Este site não consegue ler o que você digita lá. O Li não vê esta página, a menos que você compartilhe algo.",
      promptWarn: "O Li pode errar. Não cole senhas nem dados privados desta página.",
      allowOnce: "Permitir uma vez",
      allowAlways: "Sempre neste site",
      neverHere: "Nunca neste site",
      notNow: "Agora não",
      sitesTitle: "Chat do Li: sites",
      sitesMenu: "Chat do Li: sites…",
      sitesEmpty: "Nenhum site ainda.",
      sitesAllowed: "Permitido",
      sitesNever: "Nunca",
      forget: "Esquecer",
      close: "Fechar",
      blocked: "Este site bloqueia a janela privada do Li, então o Li não pode abrir aqui.",
      openLianki: "Conversar no lianki.com",
    },
    ru: {
      liTitle: "Чат с Li",
      promptTitle: "Разрешить чат Li на {host}?",
      promptBody:
        "Li работает в собственном окне с lianki.com. Этот сайт не может прочитать то, что вы там вводите. Li не видит эту страницу, если вы сами чем-то не поделитесь.",
      promptWarn: "Li может ошибаться. Не вставляйте пароли и личные данные с этой страницы.",
      allowOnce: "Разрешить один раз",
      allowAlways: "Всегда на этом сайте",
      neverHere: "Никогда на этом сайте",
      notNow: "Не сейчас",
      sitesTitle: "Чат Li: сайты",
      sitesMenu: "Чат Li: сайты…",
      sitesEmpty: "Пока нет сайтов.",
      sitesAllowed: "Разрешено",
      sitesNever: "Никогда",
      forget: "Забыть",
      close: "Закрыть",
      blocked: "Этот сайт блокирует отдельное окно Li, поэтому Li здесь не откроется.",
      openLianki: "Общаться на lianki.com",
    },
    ur: {
      liTitle: "Li سے چیٹ کریں",
      promptTitle: "کیا {host} پر Li چیٹ کی اجازت دیں؟",
      promptBody:
        "Li، lianki.com کی اپنی الگ ونڈو میں چلتا ہے۔ یہ سائٹ وہ نہیں پڑھ سکتی جو آپ وہاں لکھتے ہیں۔ جب تک آپ کچھ شیئر نہ کریں، Li یہ صفحہ نہیں دیکھتا۔",
      promptWarn: "Li غلطی کر سکتا ہے۔ اس صفحے سے پاس ورڈ یا نجی معلومات یہاں پیسٹ نہ کریں۔",
      allowOnce: "ایک بار اجازت دیں",
      allowAlways: "اس سائٹ پر ہمیشہ",
      neverHere: "اس سائٹ پر کبھی نہیں",
      notNow: "ابھی نہیں",
      sitesTitle: "Li چیٹ: سائٹس",
      sitesMenu: "Li چیٹ: سائٹس…",
      sitesEmpty: "ابھی کوئی سائٹ نہیں۔",
      sitesAllowed: "اجازت ہے",
      sitesNever: "کبھی نہیں",
      forget: "ہٹائیں",
      close: "بند کریں",
      blocked: "یہ سائٹ Li کی نجی ونڈو کو روکتی ہے، اس لیے Li یہاں نہیں کھل سکتا۔",
      openLianki: "lianki.com پر چیٹ کریں",
    },
    id: {
      liTitle: "Ngobrol dengan Li",
      promptTitle: "Izinkan obrolan Li di {host}?",
      promptBody:
        "Li berjalan di jendelanya sendiri dari lianki.com. Situs ini tidak bisa membaca apa yang Anda ketik di sana. Li tidak melihat halaman ini kecuali Anda membagikan sesuatu.",
      promptWarn: "Li bisa keliru. Jangan tempel kata sandi atau data pribadi dari halaman ini.",
      allowOnce: "Izinkan sekali",
      allowAlways: "Selalu di situs ini",
      neverHere: "Jangan pernah di situs ini",
      notNow: "Nanti saja",
      sitesTitle: "Obrolan Li: situs",
      sitesMenu: "Obrolan Li: situs…",
      sitesEmpty: "Belum ada situs.",
      sitesAllowed: "Diizinkan",
      sitesNever: "Tidak pernah",
      forget: "Lupakan",
      close: "Tutup",
      blocked: "Situs ini memblokir jendela pribadi Li, jadi Li tidak bisa dibuka di sini.",
      openLianki: "Ngobrol di lianki.com",
    },
    de: {
      liTitle: "Mit Li chatten",
      promptTitle: "Li-Chat auf {host} erlauben?",
      promptBody:
        "Li läuft in einem eigenen Fenster von lianki.com. Diese Website kann nicht lesen, was du dort tippst. Li sieht diese Seite nicht, außer du teilst etwas.",
      promptWarn:
        "Li kann Fehler machen. Füge keine Passwörter oder privaten Daten von dieser Seite ein.",
      allowOnce: "Einmal erlauben",
      allowAlways: "Immer auf dieser Website",
      neverHere: "Nie auf dieser Website",
      notNow: "Jetzt nicht",
      sitesTitle: "Li-Chat: Websites",
      sitesMenu: "Li-Chat: Websites…",
      sitesEmpty: "Noch keine Websites.",
      sitesAllowed: "Erlaubt",
      sitesNever: "Nie",
      forget: "Vergessen",
      close: "Schließen",
      blocked:
        "Diese Website blockiert das private Fenster von Li, daher kann Li hier nicht öffnen.",
      openLianki: "Auf lianki.com chatten",
    },
    ja: {
      liTitle: "Li とチャット",
      promptTitle: "{host} で Li チャットを許可しますか？",
      promptBody:
        "Li は lianki.com の専用ウィンドウで動きます。このサイトは、そこで入力した内容を読めません。共有しない限り、Li もこのページを見ません。",
      promptWarn:
        "Li は間違えることがあります。このページのパスワードや個人情報は貼り付けないでください。",
      allowOnce: "今回だけ許可",
      allowAlways: "このサイトで常に許可",
      neverHere: "このサイトでは許可しない",
      notNow: "今はしない",
      sitesTitle: "Li チャット：サイト",
      sitesMenu: "Li チャット：サイト…",
      sitesEmpty: "まだサイトはありません。",
      sitesAllowed: "許可",
      sitesNever: "許可しない",
      forget: "削除",
      close: "閉じる",
      blocked: "このサイトは Li の専用ウィンドウをブロックしているため、ここでは Li を開けません。",
      openLianki: "lianki.com でチャット",
    },
    sw: {
      liTitle: "Ongea na Li",
      promptTitle: "Ruhusu gumzo la Li kwenye {host}?",
      promptBody:
        "Li inaendeshwa kwenye dirisha lake kutoka lianki.com. Tovuti hii haiwezi kusoma unachoandika humo. Li haioni ukurasa huu isipokuwa ukishiriki kitu.",
      promptWarn: "Li inaweza kukosea. Usibandike nenosiri au data binafsi kutoka ukurasa huu.",
      allowOnce: "Ruhusu mara moja",
      allowAlways: "Daima kwenye tovuti hii",
      neverHere: "Kamwe kwenye tovuti hii",
      notNow: "Si sasa",
      sitesTitle: "Gumzo la Li: tovuti",
      sitesMenu: "Gumzo la Li: tovuti…",
      sitesEmpty: "Bado hakuna tovuti.",
      sitesAllowed: "Imeruhusiwa",
      sitesNever: "Kamwe",
      forget: "Sahau",
      close: "Funga",
      blocked: "Tovuti hii inazuia dirisha binafsi la Li, kwa hiyo Li haiwezi kufunguka hapa.",
      openLianki: "Ongea kwenye lianki.com",
    },
    mr: {
      liTitle: "Li शी गप्पा मारा",
      promptTitle: "{host} वर Li चॅटला परवानगी द्यायची?",
      promptBody:
        "Li हे lianki.com च्या स्वतःच्या वेगळ्या विंडोमध्ये चालते. तुम्ही तिथे काय टाइप करता ते ही साइट वाचू शकत नाही. तुम्ही काही शेअर केल्याशिवाय Li हे पेज पाहत नाही.",
      promptWarn: "Li कडून चुका होऊ शकतात. या पेजवरील पासवर्ड किंवा खासगी माहिती इथे पेस्ट करू नका.",
      allowOnce: "एकदाच परवानगी द्या",
      allowAlways: "या साइटवर नेहमी",
      neverHere: "या साइटवर कधीही नाही",
      notNow: "आता नाही",
      sitesTitle: "Li चॅट: साइट्स",
      sitesMenu: "Li चॅट: साइट्स…",
      sitesEmpty: "अजून कोणतीही साइट नाही.",
      sitesAllowed: "परवानगी आहे",
      sitesNever: "कधीही नाही",
      forget: "काढा",
      close: "बंद करा",
      blocked: "ही साइट Li ची खासगी विंडो अडवते, त्यामुळे Li इथे उघडू शकत नाही.",
      openLianki: "lianki.com वर चॅट करा",
    },
    ko: {
      liTitle: "Li와 채팅",
      promptTitle: "{host}에서 Li 채팅을 허용할까요?",
      promptBody:
        "Li는 lianki.com의 별도 창에서 실행됩니다. 이 사이트는 그 안에 입력한 내용을 읽을 수 없습니다. 직접 공유하지 않는 한 Li도 이 페이지를 보지 않습니다.",
      promptWarn: "Li는 실수할 수 있습니다. 이 페이지의 비밀번호나 개인 정보를 붙여 넣지 마세요.",
      allowOnce: "이번만 허용",
      allowAlways: "이 사이트에서 항상 허용",
      neverHere: "이 사이트에서 허용 안 함",
      notNow: "나중에",
      sitesTitle: "Li 채팅: 사이트",
      sitesMenu: "Li 채팅: 사이트…",
      sitesEmpty: "아직 사이트가 없습니다.",
      sitesAllowed: "허용됨",
      sitesNever: "허용 안 함",
      forget: "삭제",
      close: "닫기",
      blocked: "이 사이트는 Li의 별도 창을 차단하므로 여기서는 Li를 열 수 없습니다.",
      openLianki: "lianki.com에서 채팅",
    },
  };
  function pillChatLang(lang = globalThis.navigator?.language) {
    const base = String(lang ?? "")
      .toLowerCase()
      .split(/[-_]/)[0];
    return PILL_CHAT_LOCALES.includes(base) ? base : "en";
  }
  var pillChatStrings = (lang) => PILL_CHAT_STRINGS[pillChatLang(lang)];

  // src/userscript-strings.ts
  var USERSCRIPT_STRINGS = {
    en: {
      again: "Again",
      hard: "Hard",
      good: "Good",
      easy: "Easy",
      open: "Open",
      syncedCloud: "Synced to your Lianki account",
      savedOffline: "Offline: saved in this browser, syncs later",
      savedLocal: "Saved in this browser only: sign in to sync (it's free)",
      due: "due: {n}",
      slower: "Slower (,/v)",
      faster: "Faster (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Review this card (Alt+F)",
      addCard: "Add to LiCards (Alt+F)",
      adding: "Adding the card…",
      errOffline: "You're offline. Please try again when you're back online.",
      errSignIn: "Please sign in to Lianki.",
      errServer: "Lianki's server is busy. Please try again in a moment.",
      errOther: "Something went wrong. Please try again.",
      signIn: "Sign in to Lianki",
      copyError: "Copy error details",
      copied: "Copied!",
      delete: "Delete",
      hints: "A/H=Again · S/J=Hard · W/K=Good · D/L=Easy · T/M=Delete · Esc=Close",
      notes: "Notes…",
      restore: "Restore it (R)",
      restoreHint: "Restoring keeps its review history.",
      reviewed: "Reviewed! Next: {due}",
      deleted: "Deleted!",
      loadingNext: "Loading the next card…",
      opening: `Opening:
{title}`,
      skipped: `Skipped a page that didn't open:
{url}`,
      skippedNone: "Skipped a page that didn't open; nothing else is due.",
      youDeleted: "You deleted this card.",
      redirectConfirm: `This page moved from:
{from}

To:
{to}

Update the card to the new address?`,
      offline: "Offline",
      syncing: "Syncing…",
      speedUnrated: "not rated yet · , slower · . faster",
      heatOn: "Difficulty overlay on",
      heatOff: "Difficulty overlay off",
      gdocStart: "Stream to Lianki",
      gdocStop: "Stop streaming",
      gdocFailed: "Sync failed, retrying",
      gdocOpen: "Open in Lianki",
    },
    zh: {
      again: "重来",
      hard: "困难",
      good: "良好",
      easy: "简单",
      open: "打开",
      syncedCloud: "已同步到你的 Lianki 账户",
      savedOffline: "离线：已保存在此浏览器中，稍后同步",
      savedLocal: "仅保存在此浏览器中：登录即可同步（免费）",
      due: "待复习：{n}",
      slower: "减速（,/v）",
      faster: "加速（./b）",
      liCards: "链卡（Alt+F）",
      reviewCard: "复习这张卡片（Alt+F）",
      addCard: "加入链卡（Alt+F）",
      adding: "正在添加卡片…",
      errOffline: "当前没有网络。恢复联网后请重试。",
      errSignIn: "请登录 Lianki。",
      errServer: "Lianki 服务器繁忙，请稍后重试。",
      errOther: "出了点问题，请重试。",
      signIn: "登录 Lianki",
      copyError: "复制错误详情",
      copied: "已复制！",
      delete: "删除",
      hints: "A/H=重来 · S/J=困难 · W/K=良好 · D/L=简单 · T/M=删除 · Esc=关闭",
      notes: "笔记…",
      restore: "恢复（R）",
      restoreHint: "恢复后会保留它的复习记录。",
      reviewed: "已复习！下次：{due}",
      deleted: "已删除！",
      loadingNext: "正在加载下一张卡片…",
      opening: `正在打开：
{title}`,
      skipped: `已跳过一个打不开的页面：
{url}`,
      skippedNone: "已跳过一个打不开的页面；没有其他要复习的了。",
      youDeleted: "你已删除这张卡片。",
      redirectConfirm: `这个页面已从：
{from}

移到：
{to}

把卡片更新为新地址吗？`,
      offline: "离线",
      syncing: "同步中…",
      speedUnrated: "尚未标记 · , 减速 · . 加速",
      heatOn: "难度标记已开启",
      heatOff: "难度标记已关闭",
      gdocStart: "同步到 Lianki",
      gdocStop: "停止同步",
      gdocFailed: "同步失败，重试中",
      gdocOpen: "在 Lianki 中打开",
    },
    hi: {
      again: "फिर से",
      hard: "कठिन",
      good: "अच्छा",
      easy: "आसान",
      open: "खोलें",
      syncedCloud: "आपके Lianki खाते में सिंक",
      savedOffline: "ऑफ़लाइन: इस ब्राउज़र में सहेजा गया, बाद में सिंक होगा",
      savedLocal: "केवल इस ब्राउज़र में सहेजा गया: सिंक करने के लिए साइन इन करें (मुफ़्त)",
      due: "बाकी: {n}",
      slower: "धीमा (,/v)",
      faster: "तेज़ (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "यह कार्ड दोहराएँ (Alt+F)",
      addCard: "LiCards में जोड़ें (Alt+F)",
      adding: "कार्ड जोड़ा जा रहा है…",
      errOffline: "आप ऑफ़लाइन हैं। ऑनलाइन होने पर फिर से कोशिश करें।",
      errSignIn: "कृपया Lianki में साइन इन करें।",
      errServer: "Lianki का सर्वर व्यस्त है। कृपया थोड़ी देर में फिर कोशिश करें।",
      errOther: "कुछ गड़बड़ हुई। कृपया फिर से कोशिश करें।",
      signIn: "Lianki में साइन इन करें",
      copyError: "त्रुटि विवरण कॉपी करें",
      copied: "कॉपी हो गया!",
      delete: "हटाएँ",
      hints: "A/H=फिर से · S/J=कठिन · W/K=अच्छा · D/L=आसान · T/M=हटाएँ · Esc=बंद करें",
      notes: "नोट्स…",
      restore: "वापस लाएँ (R)",
      restoreHint: "वापस लाने पर इसका दोहराव इतिहास बना रहता है।",
      reviewed: "दोहराया गया! अगली बार: {due}",
      deleted: "हटा दिया!",
      loadingNext: "अगला कार्ड लोड हो रहा है…",
      opening: `खोला जा रहा है:
{title}`,
      skipped: `एक न खुलने वाला पेज छोड़ा गया:
{url}`,
      skippedNone: "एक न खुलने वाला पेज छोड़ा गया; और कुछ बाकी नहीं।",
      youDeleted: "आपने यह कार्ड हटा दिया।",
      redirectConfirm: `यह पेज यहाँ से:
{from}

यहाँ गया:
{to}

कार्ड को नए पते पर अपडेट करें?`,
      offline: "ऑफ़लाइन",
      syncing: "सिंक हो रहा है…",
      speedUnrated: "अभी रेट नहीं · , धीमा · . तेज़",
      heatOn: "कठिनाई ओवरले चालू",
      heatOff: "कठिनाई ओवरले बंद",
      gdocStart: "Lianki पर लाइव भेजें",
      gdocStop: "लाइव भेजना बंद करें",
      gdocFailed: "सिंक नहीं हुआ, फिर से कोशिश हो रही है",
      gdocOpen: "Lianki में खोलें",
    },
    es: {
      again: "Otra vez",
      hard: "Difícil",
      good: "Bien",
      easy: "Fácil",
      open: "Abrir",
      syncedCloud: "Sincronizado con tu cuenta de Lianki",
      savedOffline: "Sin conexión: guardado en este navegador, se sincroniza después",
      savedLocal: "Guardado solo en este navegador: inicia sesión para sincronizar (es gratis)",
      due: "pendientes: {n}",
      slower: "Más lento (,/v)",
      faster: "Más rápido (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Repasar esta tarjeta (Alt+F)",
      addCard: "Añadir a LiCards (Alt+F)",
      adding: "Añadiendo la tarjeta…",
      errOffline: "No tienes conexión. Inténtalo de nuevo cuando vuelvas a estar en línea.",
      errSignIn: "Inicia sesión en Lianki.",
      errServer: "El servidor de Lianki está ocupado. Inténtalo de nuevo en un momento.",
      errOther: "Algo salió mal. Inténtalo de nuevo.",
      signIn: "Iniciar sesión en Lianki",
      copyError: "Copiar detalles del error",
      copied: "¡Copiado!",
      delete: "Borrar",
      hints: "A/H=Otra vez · S/J=Difícil · W/K=Bien · D/L=Fácil · T/M=Borrar · Esc=Cerrar",
      notes: "Notas…",
      restore: "Restaurarla (R)",
      restoreHint: "Al restaurarla se conserva su historial de repasos.",
      reviewed: "¡Repasada! Próxima: {due}",
      deleted: "¡Borrada!",
      loadingNext: "Cargando la siguiente tarjeta…",
      opening: `Abriendo:
{title}`,
      skipped: `Se omitió una página que no abrió:
{url}`,
      skippedNone: "Se omitió una página que no abrió; no hay nada más pendiente.",
      youDeleted: "Borraste esta tarjeta.",
      redirectConfirm: `Esta página se movió de:
{from}

A:
{to}

¿Actualizar la tarjeta a la nueva dirección?`,
      offline: "Sin conexión",
      syncing: "Sincronizando…",
      speedUnrated: "sin valorar · , más lento · . más rápido",
      heatOn: "Capa de dificultad activada",
      heatOff: "Capa de dificultad desactivada",
      gdocStart: "Enviar en directo a Lianki",
      gdocStop: "Dejar de enviar",
      gdocFailed: "No se pudo sincronizar; reintentando",
      gdocOpen: "Abrir en Lianki",
    },
    fr: {
      again: "À revoir",
      hard: "Difficile",
      good: "Correct",
      easy: "Facile",
      open: "Ouvrir",
      syncedCloud: "Synchronisé avec votre compte Lianki",
      savedOffline: "Hors ligne : enregistré dans ce navigateur, synchronisé plus tard",
      savedLocal:
        "Enregistré uniquement dans ce navigateur : connectez-vous pour synchroniser (c'est gratuit)",
      due: "à réviser : {n}",
      slower: "Plus lent (,/v)",
      faster: "Plus rapide (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Réviser cette carte (Alt+F)",
      addCard: "Ajouter à LiCards (Alt+F)",
      adding: "Ajout de la carte…",
      errOffline: "Vous êtes hors ligne. Réessayez une fois reconnecté.",
      errSignIn: "Connectez-vous à Lianki.",
      errServer: "Le serveur de Lianki est occupé. Réessayez dans un instant.",
      errOther: "Un problème est survenu. Réessayez.",
      signIn: "Se connecter à Lianki",
      copyError: "Copier les détails de l'erreur",
      copied: "Copié !",
      delete: "Supprimer",
      hints: "A/H=À revoir · S/J=Difficile · W/K=Correct · D/L=Facile · T/M=Supprimer · Esc=Fermer",
      notes: "Notes…",
      restore: "La restaurer (R)",
      restoreHint: "La restauration conserve son historique de révisions.",
      reviewed: "Révisée ! Prochaine : {due}",
      deleted: "Supprimée !",
      loadingNext: "Chargement de la carte suivante…",
      opening: `Ouverture :
{title}`,
      skipped: `Page ignorée car elle ne s'ouvrait pas :
{url}`,
      skippedNone: "Page ignorée car elle ne s'ouvrait pas ; rien d'autre à réviser.",
      youDeleted: "Vous avez supprimé cette carte.",
      redirectConfirm: `Cette page a été déplacée de :
{from}

Vers :
{to}

Mettre à jour la carte avec la nouvelle adresse ?`,
      offline: "Hors ligne",
      syncing: "Synchronisation…",
      speedUnrated: "pas encore noté · , plus lent · . plus rapide",
      heatOn: "Repères de difficulté activés",
      heatOff: "Repères de difficulté désactivés",
      gdocStart: "Diffuser vers Lianki",
      gdocStop: "Arrêter la diffusion",
      gdocFailed: "Échec de la synchro, nouvel essai",
      gdocOpen: "Ouvrir dans Lianki",
    },
    ar: {
      again: "مجددًا",
      hard: "صعب",
      good: "جيد",
      easy: "سهل",
      open: "فتح",
      syncedCloud: "متزامن مع حسابك على Lianki",
      savedOffline: "غير متصل: محفوظ في هذا المتصفح، وتتم المزامنة لاحقًا",
      savedLocal: "محفوظ في هذا المتصفح فقط: سجّل الدخول للمزامنة (مجانًا)",
      due: "المستحقة: {n}",
      slower: "أبطأ (,/v)",
      faster: "أسرع (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "راجع هذه البطاقة (Alt+F)",
      addCard: "أضف إلى LiCards (Alt+F)",
      adding: "جارٍ إضافة البطاقة…",
      errOffline: "أنت غير متصل. حاول مجددًا عند عودة الاتصال.",
      errSignIn: "يُرجى تسجيل الدخول إلى Lianki.",
      errServer: "خادم Lianki مشغول. حاول مجددًا بعد قليل.",
      errOther: "حدث خطأ ما. يُرجى المحاولة مجددًا.",
      signIn: "تسجيل الدخول إلى Lianki",
      copyError: "نسخ تفاصيل الخطأ",
      copied: "تم النسخ!",
      delete: "حذف",
      hints: "A/H=مجددًا · S/J=صعب · W/K=جيد · D/L=سهل · T/M=حذف · Esc=إغلاق",
      notes: "ملاحظات…",
      restore: "استعادتها (R)",
      restoreHint: "الاستعادة تحتفظ بسجل مراجعاتها.",
      reviewed: "تمت المراجعة! التالية: {due}",
      deleted: "تم الحذف!",
      loadingNext: "جارٍ تحميل البطاقة التالية…",
      opening: `جارٍ الفتح:
{title}`,
      skipped: `تم تخطي صفحة لم تُفتح:
{url}`,
      skippedNone: "تم تخطي صفحة لم تُفتح؛ لا شيء آخر مستحق.",
      youDeleted: "لقد حذفت هذه البطاقة.",
      redirectConfirm: `انتقلت هذه الصفحة من:
{from}

إلى:
{to}

هل تريد تحديث البطاقة إلى العنوان الجديد؟`,
      offline: "غير متصل",
      syncing: "جارٍ المزامنة…",
      speedUnrated: "لم يُقيَّم بعد · , أبطأ · . أسرع",
      heatOn: "طبقة الصعوبة مفعّلة",
      heatOff: "طبقة الصعوبة متوقفة",
      gdocStart: "بثّ مباشر إلى Lianki",
      gdocStop: "إيقاف البث",
      gdocFailed: "تعذّرت المزامنة، تجري إعادة المحاولة",
      gdocOpen: "فتح في Lianki",
    },
    bn: {
      again: "আবার",
      hard: "কঠিন",
      good: "ভালো",
      easy: "সহজ",
      open: "খুলুন",
      syncedCloud: "আপনার Lianki অ্যাকাউন্টে সিঙ্ক হয়েছে",
      savedOffline: "অফলাইন: এই ব্রাউজারে রাখা, পরে সিঙ্ক হবে",
      savedLocal: "শুধু এই ব্রাউজারে রাখা: সিঙ্ক করতে সাইন ইন করুন (বিনামূল্যে)",
      due: "বাকি: {n}",
      slower: "ধীরে (,/v)",
      faster: "দ্রুত (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "এই কার্ড পুনরালোচনা করুন (Alt+F)",
      addCard: "LiCards-এ যোগ করুন (Alt+F)",
      adding: "কার্ড যোগ হচ্ছে…",
      errOffline: "আপনি অফলাইনে আছেন। অনলাইনে ফিরলে আবার চেষ্টা করুন।",
      errSignIn: "অনুগ্রহ করে Lianki-তে সাইন ইন করুন।",
      errServer: "Lianki-র সার্ভার ব্যস্ত। একটু পরে আবার চেষ্টা করুন।",
      errOther: "কিছু সমস্যা হয়েছে। আবার চেষ্টা করুন।",
      signIn: "Lianki-তে সাইন ইন করুন",
      copyError: "ত্রুটির বিবরণ কপি করুন",
      copied: "কপি হয়েছে!",
      delete: "মুছুন",
      hints: "A/H=আবার · S/J=কঠিন · W/K=ভালো · D/L=সহজ · T/M=মুছুন · Esc=বন্ধ",
      notes: "নোট…",
      restore: "ফিরিয়ে আনুন (R)",
      restoreHint: "ফিরিয়ে আনলে এর পুনরালোচনার ইতিহাস থাকে।",
      reviewed: "পুনরালোচনা হয়েছে! পরের বার: {due}",
      deleted: "মুছে ফেলা হয়েছে!",
      loadingNext: "পরের কার্ড লোড হচ্ছে…",
      opening: `খোলা হচ্ছে:
{title}`,
      skipped: `না খোলা একটি পেজ বাদ দেওয়া হয়েছে:
{url}`,
      skippedNone: "না খোলা একটি পেজ বাদ দেওয়া হয়েছে; আর কিছু বাকি নেই।",
      youDeleted: "আপনি এই কার্ড মুছে ফেলেছেন।",
      redirectConfirm: `এই পেজ সরেছে এখান থেকে:
{from}

এখানে:
{to}

কার্ডটি নতুন ঠিকানায় আপডেট করবেন?`,
      offline: "অফলাইন",
      syncing: "সিঙ্ক হচ্ছে…",
      speedUnrated: "এখনো রেট করা হয়নি · , ধীরে · . দ্রুত",
      heatOn: "কঠিনতা ওভারলে চালু",
      heatOff: "কঠিনতা ওভারলে বন্ধ",
      gdocStart: "Lianki-তে লাইভ পাঠান",
      gdocStop: "লাইভ পাঠানো বন্ধ করুন",
      gdocFailed: "সিঙ্ক হয়নি, আবার চেষ্টা চলছে",
      gdocOpen: "Lianki-তে খুলুন",
    },
    pt: {
      again: "De novo",
      hard: "Difícil",
      good: "Bom",
      easy: "Fácil",
      open: "Abrir",
      syncedCloud: "Sincronizado com sua conta Lianki",
      savedOffline: "Offline: salvo neste navegador, sincroniza depois",
      savedLocal: "Salvo só neste navegador: entre para sincronizar (é grátis)",
      due: "pendentes: {n}",
      slower: "Mais devagar (,/v)",
      faster: "Mais rápido (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Revisar este cartão (Alt+F)",
      addCard: "Adicionar ao LiCards (Alt+F)",
      adding: "Adicionando o cartão…",
      errOffline: "Você está sem conexão. Tente de novo quando voltar a ficar online.",
      errSignIn: "Entre no Lianki.",
      errServer: "O servidor do Lianki está ocupado. Tente de novo em instantes.",
      errOther: "Algo deu errado. Tente novamente.",
      signIn: "Entrar no Lianki",
      copyError: "Copiar detalhes do erro",
      copied: "Copiado!",
      delete: "Excluir",
      hints: "A/H=De novo · S/J=Difícil · W/K=Bom · D/L=Fácil · T/M=Excluir · Esc=Fechar",
      notes: "Notas…",
      restore: "Restaurar (R)",
      restoreHint: "Restaurar mantém o histórico de revisões.",
      reviewed: "Revisado! Próxima: {due}",
      deleted: "Excluído!",
      loadingNext: "Carregando o próximo cartão…",
      opening: `Abrindo:
{title}`,
      skipped: `Pulamos uma página que não abriu:
{url}`,
      skippedNone: "Pulamos uma página que não abriu; nada mais pendente.",
      youDeleted: "Você excluiu este cartão.",
      redirectConfirm: `Esta página mudou de:
{from}

Para:
{to}

Atualizar o cartão para o novo endereço?`,
      offline: "Offline",
      syncing: "Sincronizando…",
      speedUnrated: "ainda sem nota · , mais devagar · . mais rápido",
      heatOn: "Camada de dificuldade ativada",
      heatOff: "Camada de dificuldade desativada",
      gdocStart: "Transmitir para o Lianki",
      gdocStop: "Parar a transmissão",
      gdocFailed: "Falha na sincronização, tentando de novo",
      gdocOpen: "Abrir no Lianki",
    },
    ru: {
      again: "Снова",
      hard: "Трудно",
      good: "Хорошо",
      easy: "Легко",
      open: "Открыть",
      syncedCloud: "Синхронизировано с аккаунтом Lianki",
      savedOffline: "Офлайн: сохранено в этом браузере, синхронизируется позже",
      savedLocal: "Сохранено только в этом браузере: войдите, чтобы синхронизировать (бесплатно)",
      due: "к повторению: {n}",
      slower: "Медленнее (,/v)",
      faster: "Быстрее (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Повторить эту карточку (Alt+F)",
      addCard: "Добавить в LiCards (Alt+F)",
      adding: "Добавляем карточку…",
      errOffline: "Нет подключения к сети. Попробуйте снова, когда оно появится.",
      errSignIn: "Войдите в Lianki.",
      errServer: "Сервер Lianki занят. Попробуйте чуть позже.",
      errOther: "Что-то пошло не так. Попробуйте ещё раз.",
      signIn: "Войти в Lianki",
      copyError: "Скопировать подробности ошибки",
      copied: "Скопировано!",
      delete: "Удалить",
      hints: "A/H=Снова · S/J=Трудно · W/K=Хорошо · D/L=Легко · T/M=Удалить · Esc=Закрыть",
      notes: "Заметки…",
      restore: "Восстановить (R)",
      restoreHint: "При восстановлении история повторений сохраняется.",
      reviewed: "Повторено! Дальше: {due}",
      deleted: "Удалено!",
      loadingNext: "Загружаем следующую карточку…",
      opening: `Открываем:
{title}`,
      skipped: `Пропущена страница, которая не открылась:
{url}`,
      skippedNone: "Пропущена страница, которая не открылась; больше повторять нечего.",
      youDeleted: "Вы удалили эту карточку.",
      redirectConfirm: `Страница переехала с:
{from}

На:
{to}

Обновить карточку на новый адрес?`,
      offline: "Офлайн",
      syncing: "Синхронизация…",
      speedUnrated: "ещё не оценено · , медленнее · . быстрее",
      heatOn: "Метки сложности включены",
      heatOff: "Метки сложности выключены",
      gdocStart: "Транслировать в Lianki",
      gdocStop: "Остановить трансляцию",
      gdocFailed: "Не удалось синхронизировать, пробуем снова",
      gdocOpen: "Открыть в Lianki",
    },
    ur: {
      again: "دوبارہ",
      hard: "مشکل",
      good: "اچھا",
      easy: "آسان",
      open: "کھولیں",
      syncedCloud: "آپ کے Lianki اکاؤنٹ سے ہم آہنگ",
      savedOffline: "آف لائن: اس براؤزر میں محفوظ، بعد میں ہم آہنگ ہوگا",
      savedLocal: "صرف اس براؤزر میں محفوظ: ہم آہنگ کرنے کے لیے سائن ان کریں (مفت)",
      due: "باقی: {n}",
      slower: "آہستہ (,/v)",
      faster: "تیز (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "یہ کارڈ دہرائیں (Alt+F)",
      addCard: "LiCards میں شامل کریں (Alt+F)",
      adding: "کارڈ شامل ہو رہا ہے…",
      errOffline: "آپ آف لائن ہیں۔ آن لائن ہونے پر دوبارہ کوشش کریں۔",
      errSignIn: "براہِ کرم Lianki میں سائن ان کریں۔",
      errServer: "Lianki کا سرور مصروف ہے۔ تھوڑی دیر میں دوبارہ کوشش کریں۔",
      errOther: "کچھ غلط ہو گیا۔ براہِ کرم دوبارہ کوشش کریں۔",
      signIn: "Lianki میں سائن ان کریں",
      copyError: "خرابی کی تفصیل کاپی کریں",
      copied: "کاپی ہو گیا!",
      delete: "حذف کریں",
      hints: "A/H=دوبارہ · S/J=مشکل · W/K=اچھا · D/L=آسان · T/M=حذف · Esc=بند",
      notes: "نوٹس…",
      restore: "بحال کریں (R)",
      restoreHint: "بحال کرنے سے اس کی دہرائی کی تاریخ برقرار رہتی ہے۔",
      reviewed: "دہرا لیا! اگلی بار: {due}",
      deleted: "حذف ہو گیا!",
      loadingNext: "اگلا کارڈ لوڈ ہو رہا ہے…",
      opening: `کھولا جا رہا ہے:
{title}`,
      skipped: `ایک نہ کھلنے والا صفحہ چھوڑ دیا گیا:
{url}`,
      skippedNone: "ایک نہ کھلنے والا صفحہ چھوڑا گیا؛ اور کچھ باقی نہیں۔",
      youDeleted: "آپ نے یہ کارڈ حذف کر دیا۔",
      redirectConfirm: `یہ صفحہ یہاں سے:
{from}

یہاں منتقل ہوا:
{to}

کیا کارڈ کو نئے پتے پر اپ ڈیٹ کریں؟`,
      offline: "آف لائن",
      syncing: "ہم آہنگی ہو رہی ہے…",
      speedUnrated: "ابھی درجہ نہیں · , آہستہ · . تیز",
      heatOn: "مشکل اوورلے آن",
      heatOff: "مشکل اوورلے آف",
      gdocStart: "Lianki پر لائیو بھیجیں",
      gdocStop: "لائیو بھیجنا بند کریں",
      gdocFailed: "ہم آہنگی نہیں ہوئی، دوبارہ کوشش جاری ہے",
      gdocOpen: "Lianki میں کھولیں",
    },
    id: {
      again: "Lagi",
      hard: "Sulit",
      good: "Baik",
      easy: "Mudah",
      open: "Buka",
      syncedCloud: "Tersinkron ke akun Lianki Anda",
      savedOffline: "Offline: tersimpan di browser ini, disinkronkan nanti",
      savedLocal: "Hanya tersimpan di browser ini: masuk untuk menyinkronkan (gratis)",
      due: "jatuh tempo: {n}",
      slower: "Lebih lambat (,/v)",
      faster: "Lebih cepat (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Ulas kartu ini (Alt+F)",
      addCard: "Tambahkan ke LiCards (Alt+F)",
      adding: "Menambahkan kartu…",
      errOffline: "Anda sedang offline. Coba lagi saat kembali online.",
      errSignIn: "Silakan masuk ke Lianki.",
      errServer: "Server Lianki sedang sibuk. Coba lagi sebentar lagi.",
      errOther: "Terjadi kesalahan. Silakan coba lagi.",
      signIn: "Masuk ke Lianki",
      copyError: "Salin detail kesalahan",
      copied: "Disalin!",
      delete: "Hapus",
      hints: "A/H=Lagi · S/J=Sulit · W/K=Baik · D/L=Mudah · T/M=Hapus · Esc=Tutup",
      notes: "Catatan…",
      restore: "Pulihkan (R)",
      restoreHint: "Memulihkan tetap menyimpan riwayat ulasannya.",
      reviewed: "Diulas! Berikutnya: {due}",
      deleted: "Dihapus!",
      loadingNext: "Memuat kartu berikutnya…",
      opening: `Membuka:
{title}`,
      skipped: `Melewati halaman yang tidak terbuka:
{url}`,
      skippedNone: "Melewati halaman yang tidak terbuka; tidak ada lagi yang jatuh tempo.",
      youDeleted: "Anda menghapus kartu ini.",
      redirectConfirm: `Halaman ini pindah dari:
{from}

Ke:
{to}

Perbarui kartu ke alamat baru?`,
      offline: "Offline",
      syncing: "Menyinkronkan…",
      speedUnrated: "belum dinilai · , lebih lambat · . lebih cepat",
      heatOn: "Lapisan kesulitan aktif",
      heatOff: "Lapisan kesulitan nonaktif",
      gdocStart: "Kirim langsung ke Lianki",
      gdocStop: "Berhenti mengirim",
      gdocFailed: "Gagal sinkron, mencoba lagi",
      gdocOpen: "Buka di Lianki",
    },
    de: {
      again: "Nochmal",
      hard: "Schwer",
      good: "Gut",
      easy: "Einfach",
      open: "Öffnen",
      syncedCloud: "Mit deinem Lianki-Konto synchronisiert",
      savedOffline: "Offline: in diesem Browser gespeichert, wird später synchronisiert",
      savedLocal: "Nur in diesem Browser gespeichert: zum Synchronisieren anmelden (kostenlos)",
      due: "fällig: {n}",
      slower: "Langsamer (,/v)",
      faster: "Schneller (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Diese Karte wiederholen (Alt+F)",
      addCard: "Zu LiCards hinzufügen (Alt+F)",
      adding: "Karte wird hinzugefügt…",
      errOffline: "Du bist offline. Versuche es erneut, wenn du wieder online bist.",
      errSignIn: "Bitte melde dich bei Lianki an.",
      errServer: "Lianki ist gerade ausgelastet. Bitte versuche es gleich noch einmal.",
      errOther: "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
      signIn: "Bei Lianki anmelden",
      copyError: "Fehlerdetails kopieren",
      copied: "Kopiert!",
      delete: "Löschen",
      hints: "A/H=Nochmal · S/J=Schwer · W/K=Gut · D/L=Einfach · T/M=Löschen · Esc=Schließen",
      notes: "Notizen…",
      restore: "Wiederherstellen (R)",
      restoreHint: "Beim Wiederherstellen bleibt der Wiederholungsverlauf erhalten.",
      reviewed: "Wiederholt! Nächstes Mal: {due}",
      deleted: "Gelöscht!",
      loadingNext: "Nächste Karte wird geladen…",
      opening: `Wird geöffnet:
{title}`,
      skipped: `Eine Seite, die sich nicht öffnete, wurde übersprungen:
{url}`,
      skippedNone:
        "Eine Seite, die sich nicht öffnete, wurde übersprungen; sonst ist nichts fällig.",
      youDeleted: "Du hast diese Karte gelöscht.",
      redirectConfirm: `Diese Seite ist umgezogen von:
{from}

Nach:
{to}

Karte auf die neue Adresse ändern?`,
      offline: "Offline",
      syncing: "Wird synchronisiert…",
      speedUnrated: "noch nicht bewertet · , langsamer · . schneller",
      heatOn: "Schwierigkeitsanzeige an",
      heatOff: "Schwierigkeitsanzeige aus",
      gdocStart: "Live an Lianki senden",
      gdocStop: "Senden beenden",
      gdocFailed: "Synchronisieren fehlgeschlagen, neuer Versuch",
      gdocOpen: "In Lianki öffnen",
    },
    ja: {
      again: "もう一度",
      hard: "難しい",
      good: "正解",
      easy: "簡単",
      open: "開く",
      syncedCloud: "Lianki アカウントと同期済み",
      savedOffline: "オフライン：このブラウザに保存、あとで同期",
      savedLocal: "このブラウザにだけ保存：ログインで同期できます（無料）",
      due: "復習待ち：{n}",
      slower: "遅く（,/v）",
      faster: "速く（./b）",
      liCards: "LiCards（Alt+F）",
      reviewCard: "このカードを復習（Alt+F）",
      addCard: "LiCards に追加（Alt+F）",
      adding: "カードを追加中…",
      errOffline: "オフラインです。オンラインに戻ったらもう一度お試しください。",
      errSignIn: "Lianki にログインしてください。",
      errServer: "Lianki のサーバーが混み合っています。少ししてからお試しください。",
      errOther: "問題が発生しました。もう一度お試しください。",
      signIn: "Lianki にログイン",
      copyError: "エラーの詳細をコピー",
      copied: "コピーしました！",
      delete: "削除",
      hints: "A/H=もう一度 · S/J=難しい · W/K=正解 · D/L=簡単 · T/M=削除 · Esc=閉じる",
      notes: "メモ…",
      restore: "元に戻す（R）",
      restoreHint: "元に戻すと復習の記録も残ります。",
      reviewed: "復習しました！次回：{due}",
      deleted: "削除しました！",
      loadingNext: "次のカードを読み込み中…",
      opening: `開いています：
{title}`,
      skipped: `開けないページをスキップしました：
{url}`,
      skippedNone: "開けないページをスキップしました。ほかに復習するカードはありません。",
      youDeleted: "このカードは削除済みです。",
      redirectConfirm: `このページは移動しました。移動元：
{from}

移動先：
{to}

カードを新しいアドレスに更新しますか？`,
      offline: "オフライン",
      syncing: "同期中…",
      speedUnrated: "未評価 · , 遅く · . 速く",
      heatOn: "難易度表示オン",
      heatOff: "難易度表示オフ",
      gdocStart: "Lianki にライブ送信",
      gdocStop: "送信を止める",
      gdocFailed: "同期に失敗、再試行中",
      gdocOpen: "Lianki で開く",
    },
    sw: {
      again: "Tena",
      hard: "Ngumu",
      good: "Vizuri",
      easy: "Rahisi",
      open: "Fungua",
      syncedCloud: "Imesawazishwa na akaunti yako ya Lianki",
      savedOffline: "Nje ya mtandao: imehifadhiwa kwenye kivinjari hiki, itasawazishwa baadaye",
      savedLocal: "Imehifadhiwa kwenye kivinjari hiki pekee: ingia ili kusawazisha (bure)",
      due: "zinazosubiri: {n}",
      slower: "Polepole (,/v)",
      faster: "Haraka (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "Rudia kadi hii (Alt+F)",
      addCard: "Ongeza kwenye LiCards (Alt+F)",
      adding: "Inaongeza kadi…",
      errOffline: "Huna mtandao. Jaribu tena ukirudi mtandaoni.",
      errSignIn: "Tafadhali ingia kwenye Lianki.",
      errServer: "Seva ya Lianki ina shughuli nyingi. Jaribu tena baada ya muda.",
      errOther: "Kuna hitilafu. Tafadhali jaribu tena.",
      signIn: "Ingia kwenye Lianki",
      copyError: "Nakili maelezo ya hitilafu",
      copied: "Imenakiliwa!",
      delete: "Futa",
      hints: "A/H=Tena · S/J=Ngumu · W/K=Vizuri · D/L=Rahisi · T/M=Futa · Esc=Funga",
      notes: "Maelezo…",
      restore: "Irejeshe (R)",
      restoreHint: "Kuirejesha huhifadhi historia yake ya marudio.",
      reviewed: "Imerudiwa! Inayofuata: {due}",
      deleted: "Imefutwa!",
      loadingNext: "Inapakia kadi inayofuata…",
      opening: `Inafungua:
{title}`,
      skipped: `Imeruka ukurasa usiofunguka:
{url}`,
      skippedNone: "Imeruka ukurasa usiofunguka; hakuna kingine kinachosubiri.",
      youDeleted: "Ulifuta kadi hii.",
      redirectConfirm: `Ukurasa huu umehamishwa kutoka:
{from}

Kwenda:
{to}

Sasisha kadi kwa anwani mpya?`,
      offline: "Nje ya mtandao",
      syncing: "Inasawazisha…",
      speedUnrated: "bado haijapimwa · , polepole · . haraka",
      heatOn: "Alama za ugumu zimewashwa",
      heatOff: "Alama za ugumu zimezimwa",
      gdocStart: "Tuma moja kwa moja kwa Lianki",
      gdocStop: "Acha kutuma",
      gdocFailed: "Usawazishaji umeshindwa, inajaribu tena",
      gdocOpen: "Fungua kwenye Lianki",
    },
    mr: {
      again: "पुन्हा",
      hard: "कठीण",
      good: "चांगले",
      easy: "सोपे",
      open: "उघडा",
      syncedCloud: "तुमच्या Lianki खात्याशी सिंक",
      savedOffline: "ऑफलाइन: या ब्राउझरमध्ये जतन, नंतर सिंक होईल",
      savedLocal: "फक्त या ब्राउझरमध्ये जतन: सिंकसाठी साइन इन करा (मोफत)",
      due: "बाकी: {n}",
      slower: "हळू (,/v)",
      faster: "जलद (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "हे कार्ड उजळा (Alt+F)",
      addCard: "LiCards मध्ये जोडा (Alt+F)",
      adding: "कार्ड जोडत आहे…",
      errOffline: "तुम्ही ऑफलाइन आहात. ऑनलाइन आल्यावर पुन्हा प्रयत्न करा.",
      errSignIn: "कृपया Lianki मध्ये साइन इन करा.",
      errServer: "Lianki चा सर्व्हर व्यस्त आहे. थोड्या वेळाने पुन्हा प्रयत्न करा.",
      errOther: "काहीतरी चुकले. कृपया पुन्हा प्रयत्न करा.",
      signIn: "Lianki मध्ये साइन इन करा",
      copyError: "त्रुटीचा तपशील कॉपी करा",
      copied: "कॉपी झाले!",
      delete: "हटवा",
      hints: "A/H=पुन्हा · S/J=कठीण · W/K=चांगले · D/L=सोपे · T/M=हटवा · Esc=बंद",
      notes: "नोंदी…",
      restore: "परत आणा (R)",
      restoreHint: "परत आणल्यास उजळणी इतिहास कायम राहतो.",
      reviewed: "उजळणी झाली! पुढची: {due}",
      deleted: "हटवले!",
      loadingNext: "पुढचे कार्ड लोड होत आहे…",
      opening: `उघडत आहे:
{title}`,
      skipped: `न उघडणारे पान वगळले:
{url}`,
      skippedNone: "न उघडणारे पान वगळले; आणखी काही बाकी नाही.",
      youDeleted: "तुम्ही हे कार्ड हटवले.",
      redirectConfirm: `हे पान इथून हलले:
{from}

इथे:
{to}

कार्ड नव्या पत्त्यावर अपडेट करायचे?`,
      offline: "ऑफलाइन",
      syncing: "सिंक होत आहे…",
      speedUnrated: "अजून रेट नाही · , हळू · . जलद",
      heatOn: "कठीणता ओव्हरले चालू",
      heatOff: "कठीणता ओव्हरले बंद",
      gdocStart: "Lianki वर थेट पाठवा",
      gdocStop: "थेट पाठवणे थांबवा",
      gdocFailed: "सिंक झाले नाही, पुन्हा प्रयत्न करत आहे",
      gdocOpen: "Lianki मध्ये उघडा",
    },
    ko: {
      again: "다시",
      hard: "어려움",
      good: "알맞음",
      easy: "쉬움",
      open: "열기",
      syncedCloud: "Lianki 계정과 동기화됨",
      savedOffline: "오프라인: 이 브라우저에 저장됨, 나중에 동기화",
      savedLocal: "이 브라우저에만 저장됨: 로그인하면 동기화(무료)",
      due: "복습할 카드: {n}",
      slower: "느리게 (,/v)",
      faster: "빠르게 (./b)",
      liCards: "LiCards (Alt+F)",
      reviewCard: "이 카드 복습 (Alt+F)",
      addCard: "LiCards에 추가 (Alt+F)",
      adding: "카드 추가 중…",
      errOffline: "오프라인 상태입니다. 다시 연결되면 시도해 주세요.",
      errSignIn: "Lianki에 로그인해 주세요.",
      errServer: "Lianki 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.",
      errOther: "문제가 발생했습니다. 다시 시도해 주세요.",
      signIn: "Lianki에 로그인",
      copyError: "오류 세부 정보 복사",
      copied: "복사됨!",
      delete: "삭제",
      hints: "A/H=다시 · S/J=어려움 · W/K=알맞음 · D/L=쉬움 · T/M=삭제 · Esc=닫기",
      notes: "메모…",
      restore: "복원 (R)",
      restoreHint: "복원하면 복습 기록이 유지됩니다.",
      reviewed: "복습 완료! 다음: {due}",
      deleted: "삭제됨!",
      loadingNext: "다음 카드 불러오는 중…",
      opening: `여는 중:
{title}`,
      skipped: `열리지 않는 페이지를 건너뛰었습니다:
{url}`,
      skippedNone: "열리지 않는 페이지를 건너뛰었습니다. 더 복습할 카드가 없습니다.",
      youDeleted: "이 카드를 삭제했습니다.",
      redirectConfirm: `이 페이지가 이동했습니다. 이전:
{from}

새 주소:
{to}

카드를 새 주소로 바꿀까요?`,
      offline: "오프라인",
      syncing: "동기화 중…",
      speedUnrated: "아직 평가 안 됨 · , 느리게 · . 빠르게",
      heatOn: "난이도 표시 켬",
      heatOff: "난이도 표시 끔",
      gdocStart: "Lianki로 실시간 보내기",
      gdocStop: "보내기 중지",
      gdocFailed: "동기화 실패, 다시 시도 중",
      gdocOpen: "Lianki에서 열기",
    },
  };
  var userscriptStrings = (lang) => USERSCRIPT_STRINGS[pillChatLang(lang)];
  var fillUs = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  function friendlyError(raw, t) {
    const s = String(raw ?? "");
    if (/Network error|timed out|aborted|Failed to fetch|offline/i.test(s)) return t.errOffline;
    if (/Login required|\b401\b/.test(s)) return t.errSignIn;
    if (/HTTP 5\d\d/.test(s)) return t.errServer;
    return t.errOther;
  }

  // src/gdoc-stream.ts
  var TIMING = { quietMs: 4000, maxWaitMs: 20000, exportLagMs: 6000, retryShortMs: 1500 };
  function docIdOfPath(path) {
    return /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{25,128})(?:\/|$)/.exec(path)?.[1] ?? null;
  }
  function stripImages(html) {
    return html.replace(/<img\b[^>]*>/gi, "");
  }
  function looksTruncated(next, prev) {
    return prev !== null && next.length < prev.length / 2;
  }
  function startGdocStream(deps) {
    const id = docIdOfPath(location.pathname);
    if (!id) return;
    const { quietMs, maxWaitMs, exportLagMs, retryShortMs } = { ...TIMING, ...deps.timing };
    const key = `lk:gdoc-stream:${id}`;
    const us = userscriptStrings(navigator.language);
    const label = {
      start: us.gdocStart,
      stop: us.gdocStop,
      failed: us.gdocFailed,
      open: us.gdocOpen,
    };
    let on = false;
    let last = null;
    let suspect = null;
    let quiet;
    let deadline;
    let lastSignal = 0;
    let lagCheck;
    let bookId = null;
    let liveQueue = [];
    let liveBusy = false;
    let busy = false;
    let dirty = false;
    let blockedUntil = 0;
    let button = null;
    let link = null;
    let pending = null;
    const docTitle = () =>
      document.title.replace(/\s*-\s*Google (Docs|文档|ドキュメント)\s*$/i, "");
    const read = async () => {
      const res = await fetch(`/document/d/${id}/export?format=html`, { credentials: "include" });
      if (!res.ok || !/^text\/html\b/i.test(res.headers.get("content-type") ?? "")) return null;
      return stripImages(await res.text());
    };
    const send = async (html) => {
      const res = await deps.gmFetch(`${deps.origin}/api/read/gdoc/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId: id, html, title: docTitle() }),
      });
      if (res.status === 429) {
        blockedUntil = Date.now() + 1000 * (Number(res.headers.get("retry-after")) || 30);
        return false;
      }
      if (!res.ok) return res.status === 422;
      const d = await res.json();
      bookId = d.id;
      sendLive();
      const url = `${deps.origin}/reader/${d.id}?streamingFrom=google-docs`;
      if (link) {
        link.href = url;
        link.style.display = "inline";
      }
      if (pending) {
        pending.location.href = url;
        pending = null;
      }
      return true;
    };
    const sendLive = async () => {
      if (liveBusy || !bookId || !liveQueue.length || !on) return;
      if (Date.now() < blockedUntil) return;
      liveBusy = true;
      const ops = liveQueue;
      liveQueue = [];
      try {
        await deps.gmFetch(`${deps.origin}/api/read/gdoc/stream`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ book: bookId, ops }),
        });
      } catch (err) {
        console.warn("[Lianki] Docs live edit failed", err);
      }
      liveBusy = false;
      sendLive();
    };
    const check = async () => {
      clearTimeout(quiet);
      clearTimeout(deadline);
      deadline = undefined;
      if (!on) return;
      if (busy) {
        dirty = true;
        return;
      }
      if (Date.now() < blockedUntil) return;
      busy = true;
      let ok = true;
      try {
        const html = await read();
        if (html !== null && html !== last) {
          if (looksTruncated(html, last) && suspect !== html) {
            suspect = html;
            setTimeout(() => void check(), retryShortMs);
          } else {
            suspect = null;
            ok = await send(html);
            if (ok) last = html;
          }
        }
      } catch (err) {
        ok = false;
        console.warn("[Lianki] Docs stream failed", err);
      }
      busy = false;
      if (button) button.textContent = ok ? label.stop : label.failed;
      if (dirty) {
        dirty = false;
        check();
      } else if (Date.now() - lastSignal < exportLagMs) {
        clearTimeout(lagCheck);
        lagCheck = setTimeout(() => void check(), exportLagMs);
      }
    };
    const signal = () => {
      if (!on) return;
      lastSignal = Date.now();
      clearTimeout(quiet);
      quiet = setTimeout(() => void check(), quietMs);
      deadline ??= setTimeout(() => void check(), maxWaitMs);
    };
    let hooked = false;
    const hook = () => {
      if (hooked) return;
      hooked = true;
      const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const proto = page.CanvasRenderingContext2D.prototype;
      const original = proto.fillText;
      proto.fillText = function (...args) {
        signal();
        return original.apply(this, args);
      };
      const xhr = page.XMLHttpRequest.prototype;
      const text = Object.getOwnPropertyDescriptor(xhr, "responseText");
      if (!text?.get) return;
      const read = new WeakMap();
      const open = xhr.open;
      xhr.open = function (...args) {
        read.set(this, 0);
        return open.apply(this, args);
      };
      Object.defineProperty(xhr, "responseText", {
        configurable: true,
        get() {
          const v = text.get.call(this);
          try {
            if (on && v && /\/bind(\?|$)/.test(this.responseURL)) {
              const from = read.get(this) ?? v.length;
              const { ops, consumed } = parseBindOps(v.slice(from));
              read.set(this, from + consumed);
              if (ops.length) {
                liveQueue.push(...ops);
                signal();
                sendLive();
              }
            }
          } catch {}
          return v;
        },
      });
    };
    const setOn = (next) => {
      on = next;
      deps.setValue(key, next);
      if (button) button.textContent = next ? label.stop : label.start;
      if (next) {
        hook();
        check();
      } else {
        clearTimeout(quiet);
        clearTimeout(deadline);
        clearTimeout(lagCheck);
        deadline = undefined;
        last = null;
        liveQueue = [];
        if (link) link.style.display = "none";
      }
    };
    const mount = () => {
      const host = document.createElement("div");
      host.style.cssText =
        "all: initial; position: fixed; z-index: 2147483647; left: 12px; bottom: 12px;";
      const shadow = host.attachShadow({ mode: "open" });
      button = document.createElement("button");
      button.type = "button";
      button.textContent = label.start;
      button.style.cssText =
        "font: 12px system-ui, sans-serif; padding: 6px 10px; border-radius: 999px; cursor: pointer; " +
        "border: 1px solid oklch(0.8 0 0); background: oklch(1 0 0); color: oklch(0.25 0 0);";
      button.addEventListener("click", () => {
        if (!on) pending = window.open("", "_blank");
        setOn(!on);
      });
      link = document.createElement("a");
      link.textContent = label.open;
      link.target = "_blank";
      link.rel = "noopener";
      link.style.cssText =
        "display: none; margin-left: 8px; font: 12px system-ui, sans-serif; color: oklch(0.45 0.15 260);";
      shadow.append(button, link);
      document.documentElement.append(host);
    };
    deps
      .gmFetch(`${deps.origin}/api/read/gdoc/stream`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) return;
        mount();
        if (deps.getValue(key, false) === true) {
          setOn(true);
        }
      })
      .catch(() => {});
  }

  // packages/debug-chat/src/embed/guard.ts
  function own(o) {
    if (!o || typeof o !== "object") return { __proto__: null };
    try {
      return { __proto__: null, ...o };
    } catch {
      return { __proto__: null };
    }
  }
  function is(v, ...words) {
    if (typeof v !== "string") return false;
    for (let k = 0; k < words.length; k++) if (v === words[k]) return true;
    return false;
  }
  function isolatedWorld(info) {
    const i = own(info);
    const declared = own(i.script).injectInto;
    if (is(i.injectInto, "page", "Page", "PAGE") || is(declared, "page", "Page", "PAGE"))
      return false;
    if (
      is(i.sandboxMode, "raw", "Raw", "RAW", "js", "JS", "javascript", "JavaScript", "JAVASCRIPT")
    )
      return false;
    return (
      is(i.injectInto, "content", "Content", "CONTENT") || is(i.sandboxMode, "dom", "DOM", "Dom")
    );
  }
  function blockerText(b, strings, name) {
    return strings[b].replaceAll("{name}", name);
  }
  function partnerWanted(o) {
    return o.top && o.enabled && !o.hiddenHosts.includes(o.host);
  }

  // packages/debug-chat/src/chat-ui-locales.ts
  var CHAT = "the Learning Partner chat (Li), a small chat panel on every Lianki page";
  var LEGACY_CONTEXT = {
    polished: `In ${CHAT}: the small mark on a voice message the partner tidied up (punctuation, misheard words); tooltip and label. One word, a past participle.`,
    summary: `In ${CHAT}: the visible tag on a line that sums up a run of the user's spoken lines that were background talk. One word (a noun).`,
    summaryTip: `In ${CHAT}: the tooltip of that 'Summary' tag: it is a summary of what was heard, and a tap shows the lines as heard.`,
    merged: `In ${CHAT}: the small visible tag on a line where the partner joined several of the user's consecutive spoken messages into one fluent passage (same meaning, smoother wording). {n} is how many messages were joined; keep {n}. Two or three words, e.g. 'Merged 3'.`,
    mergedTip: `In ${CHAT}: the tooltip of that 'Merged {n}' tag: {n} spoken messages were joined into one passage, and a tap shows them as they were heard. Keep {n}.`,
    resumeRead: `In ${CHAT}: a chip shown after a reload cut a reply off mid-read; the browser needs a tap before it may speak, and tapping reads on from where it stopped.`,
    resumeBlocked: `In ${CHAT}: a chip shown when the browser refused to play a reply aloud (no tap on the page yet); one tap turns read-aloud back on. Only the words; an icon is added.`,
    askRecommended: `In ${CHAT}: a short tag after the answer option the partner recommends on a question card. One lower-case word.`,
    askSend: `In ${CHAT}: the button that sends the chosen answers of a question card with several questions. An imperative verb.`,
    askExpired: `In ${CHAT}: shown under a question card past its deadline (it can no longer be answered). One word, a past participle.`,
    askAnswered: `In ${CHAT}: shown under a question card that has its answer. One word, a past participle.`,
    askSent: `In ${CHAT}: shown under a question card just tapped, until the answer is confirmed. One word, a past participle.`,
    askJump: `In ${CHAT}: label of the button that scrolls up to the nearest unanswered question card; {count} is how many are unanswered above. Keep {count}.`,
    askWithdrawn: `In ${CHAT}: in place of a question card's options once the partner took the question back. One or two words, like a message marked 'withdrawn' in a chat app.`,
    fullScreen: `In ${CHAT}: the menu item and button that open the chat full screen. The platform's usual 'Full screen'.`,
    fullScreenExit: `In ${CHAT}: the button that leaves full screen. The platform's usual 'Exit full screen'.`,
    cueSend: `In ${CHAT}: an on/off menu switch: play a short sound when a voice message is sent.`,
    cueSpeech: `In ${CHAT}: an on/off menu switch: play a short sound when the mic hears speech start and end.`,
    readAloud: `In ${CHAT}: the menu row (a switch) while replies are read aloud by voice, always. A short state phrase.`,
    readAloudTyping: `In ${CHAT}: the same menu row while replies are read aloud only while the user is typing in the chat box.`,
    compactIdle: `In ${CHAT}: an on/off menu switch: while not typing, show only the last message instead of the whole conversation.`,
    compactShowAll: `In ${CHAT}: tap hint on the one-line compact chat: shows the whole conversation. An imperative phrase.`,
    tuckChat: `In ${CHAT}: tooltip and screen-reader label of the arrow on the minimized chat pill: slides the chat into the nearest screen edge. An imperative phrase.`,
    restoreChat: `In ${CHAT}: tooltip and label of the Li mark on the minimized pill, and the menu row that replaces 'Minimize': opens the full chat again. An imperative phrase.`,
    untuckChat: `In ${CHAT}: tooltip and label of the handle left on the screen edge: brings the small chat pill back. An imperative phrase.`,
  };
  var EXTRA_CONTEXT = {
    speakMicTitle: `In ${CHAT}, the menu's read-aloud row: tooltip while the mic is on; replies are always read aloud then, and the user's own setting comes back when the mic stops.`,
    speakTouchTitle: `In ${CHAT}, the menu's read-aloud row: tooltip when replies are read aloud whether typing or not, until the user turns it off.`,
    speakVoicedTitle: `In ${CHAT}, the menu's read-aloud row: tooltip after the user spoke with the mic on this device: replies are read aloud, typed or spoken, until turned off.`,
    speakTypingTitle: `In ${CHAT}, the menu's read-aloud row: tooltip when replies are read aloud only while the user is typing in the chat box (it has the focus).`,
    speakMicOn: `In ${CHAT}, the menu's read-aloud row: its text while the mic is on (replies are then read aloud). A short state phrase.`,
    speakMicUsed: `In ${CHAT}, the menu's read-aloud row: its text after the mic was used on this device. A short state phrase.`,
    speakSilent: `In ${CHAT}, the menu's read-aloud row: its text when replies are not read aloud. A short state phrase.`,
    readingSpeed: `In ${CHAT}, the menu: screen-reader label of the group of buttons that set how fast replies are read aloud.`,
    speed: `In ${CHAT}, the menu: the short visible label before the reading-speed buttons (0.8×, 1×, 1.2×…). One word.`,
    stopReading: `In ${CHAT}, the menu: item that stops reading the current reply aloud. An imperative phrase.`,
    sentencesLeft: `In ${CHAT}, the menu: in brackets after 'Stop reading', how many sentences are still to be read; {n} is a number. A label and a count; keep {n}.`,
    scrollNewest: `In ${CHAT}: screen-reader label of the round button that scrolls down to the newest message. An imperative phrase.`,
    newCount: `In ${CHAT}: added after a button's label (after a comma) when there are unread messages; {n} is how many. A short label and a count; keep {n}.`,
    working: `In ${CHAT}: screen-reader label and tooltip of the moving dots shown while the partner is preparing a reply; {name} is its name (e.g. Li). Keep {name}.`,
    minimize: `In ${CHAT}, the menu: item that shrinks the chat to a small pill. The platform's usual 'Minimize'.`,
    micListening: `In ${CHAT}: spoken by screen readers when the mic starts listening. One word or a short phrase.`,
    micReplyPlaying: `In ${CHAT}: spoken by screen readers while a reply is being read aloud (the mic waits). A short phrase.`,
    micReplyTap: `In ${CHAT}: tooltip of the mic button while a reply is being read aloud: tapping stops the reply so the user can talk.`,
    micResume: `In ${CHAT}: tooltip of the mic button when listening was paused: a tap listens again.`,
    micDictate: `In ${CHAT}: tooltip of the mic button when it is off: it listens and types what the user says into the chat box.`,
    micRecordingTap: `In ${CHAT}: tooltip of the mic button while it records the user's speech: a tap stops listening.`,
    micListeningTap: `In ${CHAT}: tooltip of the mic button while it listens: a tap stops it.`,
    micDenied: `In ${CHAT}: small note by the mic button when the browser was not allowed to use the microphone. A short statement.`,
    micNotFound: `In ${CHAT}: small note by the mic button when the device has no microphone. A short statement.`,
    micSignIn: `In ${CHAT}: small note by the mic button when speech recognition needs the user to sign in. An imperative phrase.`,
    micTooMuch: `In ${CHAT}: small note by the mic button when too much speech was sent in a short time; try again in a minute.`,
    micFailed: `In ${CHAT}: small note by the mic button for any other failure of the mic or of speech recognition. Two short sentences: it failed, try again.`,
    endedElsewhere: `In ${CHAT}: a line above the chat box when the chat was closed from another open page of Lianki; it reconnects when the user comes back to this page.`,
    rateLimited: `In ${CHAT}: a line above the chat box when the user sent too many messages; the last one was not sent; {n} is how many minutes to wait. Keep {n}.`,
  };

  // packages/debug-chat/src/ui-strings.ts
  function isZh(lang = globalThis.document?.documentElement.lang) {
    return /^zh\b/i.test(lang ?? "");
  }
  function isJa(lang = globalThis.document?.documentElement.lang) {
    return /^ja\b/i.test(lang ?? "");
  }
  var EMBED_STRINGS = {
    en: {
      pageRealm:
        "Your {name} is off on this site: your userscript manager runs Lianki inside the page, where the site's own scripts could read the chat.",
      connect: "This site's security policy blocks the connection to your {name}.",
      styles: "This site's security policy blocks your {name}'s styles.",
      script: "This site's security policy blocks your {name}'s code.",
      load: "Your {name} could not load on this page.",
      openLianki: "Open on lianki.com",
      hideHere: "Hide on this site",
      readOnly: "This site blocks private typing, so replies only show here.",
      replyOnLianki: "Reply on lianki.com",
      grip: "Drag to move; double-click to minimize",
    },
    zh: {
      pageRealm:
        "{name}在本网站已关闭：你的脚本管理器把 Lianki 运行在网页自身的环境里，网站的脚本可能读到聊天内容。",
      connect: "本网站的安全策略阻止了与{name}的连接。",
      styles: "本网站的安全策略阻止了{name}的样式。",
      script: "本网站的安全策略阻止了{name}的代码运行。",
      load: "{name}在此页面加载失败。",
      openLianki: "在 lianki.com 打开",
      hideHere: "在本网站隐藏",
      readOnly: "本网站不允许私密输入，这里只显示回复。",
      replyOnLianki: "去 lianki.com 回复",
      grip: "拖动可移动；双击可最小化",
    },
    ja: {
      pageRealm:
        "このサイトでは{name}をオフにしています。スクリプトマネージャーが Lianki をページ内で実行しており、サイトのスクリプトにチャットを読まれるおそれがあります。",
      connect: "このサイトのセキュリティポリシーにより、{name}に接続できません。",
      styles: "このサイトのセキュリティポリシーにより、{name}のスタイルが読み込めません。",
      script: "このサイトのセキュリティポリシーにより、{name}のコードを実行できません。",
      load: "このページでは{name}を読み込めませんでした。",
      openLianki: "lianki.com で開く",
      hideHere: "このサイトでは非表示",
      readOnly: "このサイトでは安全に入力できないため、返信の表示のみです。",
      replyOnLianki: "lianki.com で返信",
      grip: "ドラッグで移動、ダブルクリックで最小化",
    },
  };
  var EMBED_NAME = {
    en: "Learning Partner",
    zh: "学习伙伴",
    ja: "学習パートナー",
  };
  function embedLang(lang = globalThis.navigator?.language) {
    return isZh(lang) ? "zh" : isJa(lang) ? "ja" : "en";
  }

  // packages/debug-chat/src/embed/frame-protocol.ts
  var PROTOCOL_V = 1;
  var FRAME_UP = "partner-frame-up";
  var HELLO = "partner-hello";
  var FRAME_PATH = "/embed/partner";
  var READY_MS = 800;
  var LOAD_CAP_MS = 1e4;
  var MIN_W = 120;
  var MIN_H = 56;
  var MAX_W = 480;
  var MAX_H = 720;
  var clamp2 = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));
  var frameUrl = (origin) => `${origin}${FRAME_PATH}`;
  var rec = (d) => (d && typeof d === "object" ? d : null);
  function isFrameUp(e, frameWindow, origin) {
    const d = rec(e.data);
    return !!frameWindow && e.source === frameWindow && e.origin === origin && d?.lk === FRAME_UP;
  }
  function portMsg(data) {
    const d = rec(data);
    if (d?.type === "ready" || d?.type === "need-ticket") return { type: d.type };
    if (d?.type === "size" && Number.isFinite(d.w) && Number.isFinite(d.h))
      return {
        type: "size",
        w: clamp2(d.w, MIN_W, MAX_W),
        h: clamp2(d.h, MIN_H, MAX_H),
      };
    if (d?.type === "ticket")
      return {
        type: "ticket",
        ticket: typeof d.ticket === "string" && d.ticket.length < 1024 ? d.ticket : null,
      };
    return null;
  }
  function frameBlocked(e, origin) {
    const dir = (e.effectiveDirective || e.violatedDirective || "").split(" ")[0];
    return (
      (dir === "frame-src" || dir === "child-src" || dir === "default-src") &&
      (e.blockedURI ?? "").startsWith(origin)
    );
  }

  // src/partner-frame.ts
  var css = (el, rules) => {
    for (const [k, v] of rules) el.style.setProperty(k, v, "important");
  };
  function frameShell(d) {
    const { doc, win, origin } = d;
    const host = doc.createElement("div");
    let pos = d.pos?.get() ?? { x: 0, y: 0 };
    const place = () =>
      css(host, [
        ["all", "initial"],
        ["display", "block"],
        ["position", "fixed"],
        ["right", `${8 - pos.x}px`],
        ["bottom", `${8 - pos.y}px`],
        ["z-index", "2147483647"],
      ]);
    place();
    const root = host.attachShadow({ mode: "closed" });
    const box = doc.createElement("div");
    css(box, [
      ["all", "initial"],
      ["display", "flex"],
      ["flex-direction", "column"],
      ["align-items", "flex-end"],
      ["gap", "2px"],
    ]);
    const grip = doc.createElement("div");
    grip.setAttribute("role", "button");
    grip.setAttribute("aria-label", d.gripLabel);
    grip.title = d.gripLabel;
    css(grip, [
      ["all", "initial"],
      ["display", "block"],
      ["width", "48px"],
      ["height", "12px"],
      ["border-radius", "6px"],
      ["background", "oklch(0.55 0.02 65 / 0.55)"],
      ["cursor", "grab"],
      ["touch-action", "none"],
    ]);
    const iframe = doc.createElement("iframe");
    iframe.src = frameUrl(origin);
    iframe.referrerPolicy = "no-referrer";
    iframe.setAttribute("title", d.gripLabel);
    css(iframe, [
      ["all", "initial"],
      ["display", "block"],
      ["border", "0"],
      ["width", `${MIN_W}px`],
      ["height", `${MIN_H}px`],
      ["background", "transparent"],
      ["color-scheme", "normal"],
    ]);
    box.append(grip, iframe);
    root.append(box);
    let settle = () => {};
    let settled = false;
    const result = new Promise((resolve) => {
      settle = (r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
    });
    const timers = [];
    timers.push(setTimeout(() => settle("blocked"), d.capMs ?? LOAD_CAP_MS));
    iframe.addEventListener("load", () =>
      timers.push(setTimeout(() => settle("blocked"), d.readyMs ?? READY_MS)),
    );
    let port = null;
    const onMessage = (e) => {
      if (port || !isFrameUp(e, iframe.contentWindow, origin)) return;
      const ch = new (d.Channel ?? MessageChannel)();
      port = ch.port1;
      port.onmessage = (m) => {
        const msg = portMsg(m.data);
        if (!msg) return;
        if (msg.type === "ready") settle("ready");
        else if (msg.type === "need-ticket")
          d.ticket().then(
            (ticket) => port?.postMessage({ type: "ticket", ticket }),
            () => port?.postMessage({ type: "ticket", ticket: null }),
          );
        else if (msg.type === "size")
          css(iframe, [
            ["width", `${msg.w}px`],
            ["height", `${msg.h}px`],
          ]);
      };
      iframe.contentWindow?.postMessage({ lk: HELLO, v: PROTOCOL_V, label: d.label }, origin, [
        ch.port2,
      ]);
    };
    const onViolation = (e) => {
      if (frameBlocked(e, origin)) settle("blocked");
    };
    win.addEventListener("message", onMessage);
    doc.addEventListener("securitypolicyviolation", onViolation);
    let drag = null;
    grip.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, from: pos };
      grip.setPointerCapture?.(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => {
      if (!drag) return;
      pos = { x: drag.from.x + e.clientX - drag.x, y: drag.from.y + e.clientY - drag.y };
      place();
    });
    grip.addEventListener("pointerup", () => {
      if (drag) d.pos?.set(pos);
      drag = null;
    });
    let minimized = false;
    grip.addEventListener("dblclick", () => {
      minimized = !minimized;
      css(iframe, [["display", minimized ? "none" : "block"]]);
    });
    (doc.documentElement ?? doc.body).append(host);
    return {
      result,
      iframe,
      host,
      destroy() {
        for (const t of timers) clearTimeout(t);
        settle("blocked");
        win.removeEventListener("message", onMessage);
        doc.removeEventListener("securitypolicyviolation", onViolation);
        port?.close();
        host.remove();
      },
    };
  }

  // src/partner.ts
  var PARTNER_ON_KEY = "lianki_partner_on";
  var PARTNER_HIDDEN_KEY = "lianki_partner_hidden";
  var PARTNER_POS_KEY = "lianki_partner_pos";
  var PARTNER_STORE_PREFIX = "lianki_partner_ls:";
  var NOOP = () => {};
  function mirrorPartnerSwitch(store, setValue) {
    try {
      const v = store.getItem("lk:agent") ?? store.getItem("lk:debug");
      setValue(PARTNER_ON_KEY, v === "1");
    } catch {}
  }
  async function startPartner(d) {
    const host = d.host ?? location.host;
    const hidden = (() => {
      try {
        const v = JSON.parse(d.getValue(PARTNER_HIDDEN_KEY, "[]"));
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
      } catch {
        return [];
      }
    })();
    const wanted = partnerWanted({
      enabled: d.getValue(PARTNER_ON_KEY, false) === true,
      hiddenHosts: hidden,
      host,
      top: d.top ?? window.self === window.top,
    });
    if (!wanted) return NOOP;
    const isolated = isolatedWorld(d.info);
    d.report("partner-mode", `${isolated ? "isolated" : "page-realm"} ${host}`);
    const hideHere = () =>
      d.setValue(PARTNER_HIDDEN_KEY, JSON.stringify([...new Set([...hidden, host])]));
    if (!isolated) return pageRealmNote(d.doc ?? document, d.origin, hideHere);
    const ticket = async () => {
      try {
        const r = await d.gmFetch(`${d.origin}/api/debug/partner-ticket`, {
          method: "POST",
          headers: { "x-lianki-userscript": "1" },
          credentials: "include",
        });
        if (!r.ok) return null;
        const body = await r.json();
        return typeof body?.ticket === "string" ? body.ticket : null;
      } catch {
        return null;
      }
    };
    const first = await ticket();
    if (!first) return NOOP;
    let spare = { t: first, at: Date.now() };
    const nextTicket = async () => {
      const s = spare;
      spare = null;
      return s && Date.now() - s.at < 30000 ? s.t : ticket();
    };
    const lang = embedLang();
    const shell = (d.frame ?? frameShell)({
      doc: d.doc ?? document,
      win: d.win ?? globalThis,
      origin: d.origin,
      label: `${host}${d.path ?? location.pathname}`.slice(0, 300),
      ticket: nextTicket,
      gripLabel: EMBED_STRINGS[lang].grip,
      pos: {
        get: () => {
          const p = d.getValue(PARTNER_POS_KEY, null);
          return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
        },
        set: (p) => d.setValue(PARTNER_POS_KEY, { x: Math.round(p.x), y: Math.round(p.y) }),
      },
    });
    const how = await shell.result;
    d.report("partner-frame", `${how} ${host}`);
    if (how === "ready") return () => shell.destroy();
    shell.destroy();
    let code;
    try {
      const r = await d.gmFetch(d.src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      code = await r.text();
    } catch (e) {
      d.report("partner-load", String(e?.message ?? e));
      return NOOP;
    }
    let built;
    try {
      const factory = (0, eval)(code);
      const keys = () =>
        (d.listValues?.() ?? [])
          .filter((k) => k.startsWith(PARTNER_STORE_PREFIX))
          .map((k) => k.slice(PARTNER_STORE_PREFIX.length));
      built = factory({
        get: (k) => d.getValue(PARTNER_STORE_PREFIX + k, null),
        set: (k, v) => d.setValue(PARTNER_STORE_PREFIX + k, v),
        del: (k) => d.deleteValue(PARTNER_STORE_PREFIX + k),
        keys,
      });
    } catch (e) {
      d.report("partner-eval", String(e?.message ?? e));
      return NOOP;
    }
    let mounted = null;
    try {
      mounted = built.api.mountPartner({
        doc: d.doc ?? document,
        css: built.css,
        appOrigin: d.origin,
        ticket: nextTicket,
        WebSocket: d.WebSocket ?? WebSocket,
        readOnly: true,
        report: d.report,
        hide: () => {
          hideHere();
          mounted?.destroy();
          mounted = null;
        },
      });
    } catch (e) {
      d.report("partner-mount", String(e?.message ?? e));
    }
    return () => {
      mounted?.destroy();
      mounted = null;
    };
  }
  var styleAll = (el, css) => {
    for (const [k, v] of css) el.style.setProperty(k, v, "important");
  };
  function pageRealmNote(doc, origin, hideHere) {
    const lang = embedLang();
    const t = EMBED_STRINGS[lang];
    const host = doc.createElement("div");
    styleAll(host, [
      ["all", "initial"],
      ["display", "block"],
      ["position", "fixed"],
      ["right", "8px"],
      ["bottom", "8px"],
      ["z-index", "2147483647"],
    ]);
    const root = host.attachShadow({ mode: "closed" });
    const box = doc.createElement("div");
    box.setAttribute("role", "status");
    styleAll(box, [
      ["all", "initial"],
      ["display", "flex"],
      ["gap", "8px"],
      ["align-items", "flex-start"],
      ["max-width", "min(320px, calc(100vw - 16px))"],
      ["padding", "10px 12px"],
      ["border-radius", "12px"],
      ["background", "oklch(0.97 0.01 82 / 0.92)"],
      ["color", "oklch(0.25 0.02 65)"],
      ["border", "1px solid oklch(0.25 0.02 65 / 0.15)"],
      ["font", "13px/18px system-ui, sans-serif"],
    ]);
    const text = doc.createElement("div");
    text.textContent = blockerText("pageRealm", t, EMBED_NAME[lang]);
    const link = doc.createElement("a");
    link.href = origin;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t.openLianki;
    styleAll(link, [
      ["display", "block"],
      ["margin-top", "4px"],
      ["color", "oklch(0.45 0.12 250)"],
      ["text-decoration", "underline"],
    ]);
    text.append(link);
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", t.hideHere);
    close.title = t.hideHere;
    styleAll(close, [
      ["all", "initial"],
      ["width", "40px"],
      ["height", "40px"],
      ["margin", "-10px -8px -10px 0"],
      ["font", "18px/40px system-ui, sans-serif"],
      ["text-align", "center"],
      ["cursor", "pointer"],
      ["color", "oklch(0.25 0.02 65)"],
    ]);
    const remove = () => host.remove();
    close.addEventListener("click", () => {
      hideHere();
      remove();
    });
    box.append(text, close);
    root.append(box);
    (doc.documentElement ?? doc.body).append(host);
    return remove;
  }

  // src/pill-chat-trust.ts
  var LICHAT_SITES_KEY = "lianki_lichat_sites";
  var PILLCHAT_ON_KEY = "lianki_pillchat_on";
  var PILLCHAT_RECHECK_MS = 60000;
  var HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
  var validHost = (h) =>
    typeof h === "string" && h.length > 0 && h.length <= 253 && HOST_RE.test(h);
  var siteKey = (hostname) => {
    const h = String(hostname ?? "").toLowerCase();
    return validHost(h) ? h : null;
  };
  function parseSites(raw) {
    let v = raw;
    if (typeof raw === "string") {
      try {
        v = JSON.parse(raw);
      } catch {
        return {};
      }
    }
    const out = Object.create(null);
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [h, d] of Object.entries(v)) {
      if (validHost(h) && (d === "allow" || d === "never")) out[h] = d;
    }
    return out;
  }
  function trustStore(gm) {
    const read = () => parseSites(gm.getValue(LICHAT_SITES_KEY, "{}"));
    const write = (s) => gm.setValue(LICHAT_SITES_KEY, JSON.stringify(s));
    return {
      decision(host) {
        const k = siteKey(host);
        return k ? (read()[k] ?? null) : null;
      },
      set(host, d) {
        const k = siteKey(host);
        if (!k) return;
        write({ ...read(), [k]: d });
      },
      forget(host) {
        const s = { ...read() };
        const k = siteKey(host);
        if (!k || !(k in s)) return;
        delete s[k];
        write(s);
      },
      list() {
        return Object.entries(read()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      },
    };
  }
  function applyChoice(store, onceHosts, host, choice) {
    const k = siteKey(host);
    if (!k) return false;
    if (choice === "once") {
      onceHosts.add(k);
      return true;
    }
    if (choice === "always") {
      store.set(k, "allow");
      return true;
    }
    if (choice === "never") store.set(k, "never");
    return false;
  }
  function allowedHere(store, onceHosts, host) {
    const k = siteKey(host);
    if (!k) return false;
    const d = store.decision(k);
    if (d === "never") return false;
    return d === "allow" || onceHosts.has(k);
  }
  function flagMirrorOn(raw) {
    const v = typeof raw === "string" ? safeJson(raw) : raw;
    return !!v && typeof v === "object" && v.on === true;
  }
  function flagRecheckDue(raw, now) {
    const v = typeof raw === "string" ? safeJson(raw) : raw;
    const at = v && typeof v === "object" ? v.at : undefined;
    return (
      typeof at !== "number" || !Number.isFinite(at) || now - at >= PILLCHAT_RECHECK_MS || at > now
    );
  }
  function safeJson(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  function pillEntry(o) {
    if (!o.flagOn || !o.top || !o.host || o.decision === "never") return "hidden";
    return o.isolated ? "show" : "note";
  }

  // src/pill-chat-ui.ts
  var css2 = (el, rules) => {
    for (const [k, v] of rules) el.style.setProperty(k, v, "important");
  };
  function palette(win) {
    let dark = false;
    try {
      dark = !!win?.matchMedia?.("(prefers-color-scheme: dark)").matches;
    } catch {}
    return dark
      ? {
          surface: "oklch(0.24 0.01 65)",
          text: "oklch(0.95 0.01 82)",
          muted: "oklch(0.8 0.01 82)",
          line: "oklch(0.95 0.01 82 / 0.18)",
          warnBg: "oklch(0.32 0.06 70)",
          warnText: "oklch(0.95 0.04 85)",
          primary: "oklch(0.78 0.11 250)",
          primaryText: "oklch(0.2 0.03 250)",
          button: "oklch(0.32 0.01 65)",
          scrim: "oklch(0 0 0 / 0.45)",
        }
      : {
          surface: "oklch(0.985 0.006 82)",
          text: "oklch(0.25 0.02 65)",
          muted: "oklch(0.42 0.02 65)",
          line: "oklch(0.25 0.02 65 / 0.15)",
          warnBg: "oklch(0.95 0.05 85)",
          warnText: "oklch(0.32 0.06 60)",
          primary: "oklch(0.45 0.13 250)",
          primaryText: "oklch(0.99 0 0)",
          button: "oklch(0.93 0.01 82)",
          scrim: "oklch(0 0 0 / 0.3)",
        };
  }
  function modal(doc, p, label, onDismiss) {
    const host = doc.createElement("div");
    css2(host, [
      ["all", "initial"],
      ["display", "block"],
      ["position", "fixed"],
      ["inset", "0"],
      ["z-index", "2147483647"],
    ]);
    const root = host.attachShadow({ mode: "closed" });
    const scrim = doc.createElement("div");
    css2(scrim, [
      ["all", "initial"],
      ["display", "flex"],
      ["position", "fixed"],
      ["inset", "0"],
      ["align-items", "center"],
      ["justify-content", "center"],
      ["padding", "16px"],
      ["background", p.scrim],
      ["box-sizing", "border-box"],
    ]);
    const panel = doc.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", label);
    css2(panel, [
      ["all", "initial"],
      ["display", "flex"],
      ["flex-direction", "column"],
      ["gap", "12px"],
      ["box-sizing", "border-box"],
      ["width", "min(380px, 100%)"],
      ["max-height", "calc(100vh - 32px)"],
      ["overflow", "auto"],
      ["padding", "16px"],
      ["border-radius", "14px"],
      ["background", p.surface],
      ["color", p.text],
      ["border", `1px solid ${p.line}`],
      ["box-shadow", "0 8px 32px oklch(0 0 0 / 0.3)"],
      ["font", "14px/20px system-ui, sans-serif"],
    ]);
    scrim.append(panel);
    root.append(scrim);
    scrim.addEventListener("click", (e) => {
      if (e.isTrusted && e.target === scrim) onDismiss();
    });
    host.addEventListener("keydown", (e) => {
      if (e.isTrusted && e.key === "Escape") onDismiss();
    });
    (doc.documentElement ?? doc.body).append(host);
    return { host, panel, remove: () => host.remove() };
  }
  function button(doc, text, kind, p, act) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = text;
    css2(b, [
      ["all", "initial"],
      ["box-sizing", "border-box"],
      ["min-height", "44px"],
      ["padding", kind === "icon" ? "0" : "10px 14px"],
      ["border-radius", "10px"],
      ["font", "600 14px/20px system-ui, sans-serif"],
      ["text-align", "center"],
      ["cursor", "pointer"],
      ["color", kind === "primary" ? p.primaryText : p.text],
      ["background", kind === "primary" ? p.primary : kind === "plain" ? p.button : "transparent"],
      ...(kind === "icon"
        ? [
            ["width", "44px"],
            ["font-size", "20px"],
          ]
        : []),
    ]);
    b.addEventListener("click", (e) => {
      if (e.isTrusted) act();
    });
    b.addEventListener("focus", () => css2(b, [["outline", `2px solid ${p.primary}`]]));
    b.addEventListener("blur", () => css2(b, [["outline", "none"]]));
    return b;
  }
  function text(doc, s, rules) {
    const el = doc.createElement("div");
    el.textContent = s;
    css2(el, [
      ["all", "initial"],
      ["display", "block"],
      ["font", "inherit"],
      ["color", "inherit"],
      ...rules,
    ]);
    return el;
  }
  function trustDialog(d) {
    const t = d.strings;
    const p = palette(d.win);
    let done;
    const result = new Promise((resolve) => (done = resolve));
    const title = t.promptTitle.replace("{host}", d.host);
    let shell = null;
    const finish = (c) => {
      shell?.remove();
      shell = null;
      done(c);
    };
    shell = modal(d.doc, p, title, () => finish("dismiss"));
    const head = d.doc.createElement("div");
    css2(head, [
      ["all", "initial"],
      ["display", "flex"],
      ["align-items", "flex-start"],
      ["gap", "8px"],
    ]);
    const h = text(d.doc, title, [
      ["font", "600 16px/22px system-ui, sans-serif"],
      ["flex", "1"],
      ["overflow-wrap", "anywhere"],
      ["padding-top", "10px"],
    ]);
    h.setAttribute("role", "heading");
    const x = button(d.doc, "×", "icon", p, () => finish("dismiss"));
    x.setAttribute("aria-label", t.notNow);
    x.title = t.notNow;
    head.append(h, x);
    const body = text(d.doc, t.promptBody, [["color", p.muted]]);
    const warn = text(d.doc, t.promptWarn, [
      ["background", p.warnBg],
      ["color", p.warnText],
      ["padding", "8px 10px"],
      ["border-radius", "8px"],
    ]);
    warn.setAttribute("role", "note");
    const row = d.doc.createElement("div");
    css2(row, [
      ["all", "initial"],
      ["display", "flex"],
      ["flex-direction", "column"],
      ["gap", "8px"],
    ]);
    const always = button(d.doc, t.allowAlways, "primary", p, () => finish("always"));
    row.append(
      always,
      button(d.doc, t.allowOnce, "plain", p, () => finish("once")),
      button(d.doc, t.neverHere, "plain", p, () => finish("never")),
    );
    shell.panel.append(head, body, warn, row);
    try {
      x.focus();
    } catch {}
    return {
      result,
      remove: () => finish("dismiss"),
    };
  }
  function sitesDialog(d) {
    const t = d.strings;
    const p = palette(d.win);
    let closedResolve;
    const closed = new Promise((r) => (closedResolve = r));
    let shell = null;
    const close = () => {
      shell?.remove();
      shell = null;
      closedResolve();
    };
    shell = modal(d.doc, p, t.sitesTitle, close);
    const h = text(d.doc, t.sitesTitle, [["font", "600 16px/22px system-ui, sans-serif"]]);
    h.setAttribute("role", "heading");
    const list = d.doc.createElement("div");
    css2(list, [
      ["all", "initial"],
      ["display", "flex"],
      ["flex-direction", "column"],
      ["gap", "4px"],
      ["font", "inherit"],
      ["color", "inherit"],
    ]);
    const label = (v) => (v === "allow" ? t.sitesAllowed : t.sitesNever);
    const render = () => {
      list.replaceChildren();
      const rows = d.store.list();
      if (!rows.length) {
        list.append(text(d.doc, t.sitesEmpty, [["color", p.muted]]));
        return;
      }
      for (const [host, v] of rows) {
        const row = d.doc.createElement("div");
        css2(row, [
          ["all", "initial"],
          ["display", "flex"],
          ["align-items", "center"],
          ["gap", "8px"],
          ["padding", "4px 0"],
          ["border-bottom", `1px solid ${p.line}`],
          ["font", "inherit"],
          ["color", "inherit"],
        ]);
        const name = text(d.doc, host, [
          ["flex", "1"],
          ["min-width", "0"],
          ["overflow-wrap", "anywhere"],
        ]);
        const state = text(d.doc, label(v), [
          ["color", p.muted],
          ["font-size", "13px"],
        ]);
        const forget = button(d.doc, t.forget, "plain", p, () => {
          d.store.forget(host);
          d.onChange?.(host);
          render();
        });
        forget.setAttribute("aria-label", `${t.forget}: ${host}`);
        row.append(name, state, forget);
        list.append(row);
      }
    };
    render();
    const closeBtn = button(d.doc, t.close, "primary", p, close);
    shell.panel.append(h, list, closeBtn);
    try {
      closeBtn.focus();
    } catch {}
    return { remove: close, closed };
  }
  function blockedNote(d) {
    const t = d.strings;
    const p = palette(d.win);
    const host = d.doc.createElement("div");
    css2(host, [
      ["all", "initial"],
      ["display", "block"],
      ["position", "fixed"],
      ["right", "8px"],
      ["bottom", "8px"],
      ["z-index", "2147483647"],
    ]);
    const root = host.attachShadow({ mode: "closed" });
    const box = d.doc.createElement("div");
    box.setAttribute("role", "status");
    css2(box, [
      ["all", "initial"],
      ["display", "flex"],
      ["gap", "8px"],
      ["align-items", "flex-start"],
      ["max-width", "min(320px, calc(100vw - 16px))"],
      ["padding", "10px 12px"],
      ["border-radius", "12px"],
      ["background", p.surface],
      ["color", p.text],
      ["border", `1px solid ${p.line}`],
      ["font", "13px/18px system-ui, sans-serif"],
    ]);
    const msg = text(d.doc, t.blocked, []);
    const link = d.doc.createElement("a");
    link.href = d.origin;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t.openLianki;
    css2(link, [
      ["display", "block"],
      ["margin-top", "4px"],
      ["color", p.primary],
      ["text-decoration", "underline"],
    ]);
    msg.append(link);
    const remove = () => host.remove();
    const x = button(d.doc, "×", "icon", p, remove);
    x.setAttribute("aria-label", t.close);
    box.append(msg, x);
    root.append(box);
    (d.doc.documentElement ?? d.doc.body).append(host);
    return remove;
  }

  // src/pill-chat.ts
  async function mirrorPillChatFlag(d) {
    const now = d.now?.() ?? Date.now();
    if (!flagRecheckDue(d.getValue(PILLCHAT_ON_KEY, null), now)) return null;
    const on = await askFlag(d);
    d.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on, at: now }));
    return on;
  }
  async function askFlag(d) {
    try {
      const r = await d.gmFetch(`${d.origin}/api/ext/pill-chat`, { credentials: "include" });
      if (!r.ok) return false;
      const body = await r.json();
      return body?.on === true;
    } catch {
      return false;
    }
  }
  function pillChat(d) {
    const doc = d.doc ?? document;
    const win = d.win ?? globalThis;
    const host = siteKey(d.hostname ?? location.hostname);
    const top = d.top ?? window.self === window.top;
    const strings = d.strings ?? pillChatStrings();
    const store = trustStore(d);
    const once = new Set();
    const isolated = isolatedWorld(d.info);
    const report = d.report ?? (() => {});
    let open = null;
    let busy = false;
    let note = null;
    const entry = () =>
      pillEntry({
        flagOn: flagMirrorOn(d.getValue(PILLCHAT_ON_KEY, null)),
        top,
        isolated,
        decision: host ? store.decision(host) : null,
        host,
      });
    const prompt = d.prompt ?? ((h) => trustDialog({ doc, win, strings, host: h }).result);
    const ticket = async () => {
      try {
        const r = await d.gmFetch(`${d.origin}/api/debug/partner-ticket`, {
          method: "POST",
          headers: { "x-lianki-userscript": "1" },
          credentials: "include",
        });
        if (!r.ok) return null;
        const body = await r.json();
        return typeof body?.ticket === "string" ? body.ticket : null;
      } catch {
        return null;
      }
    };
    const close = () => {
      open?.destroy();
      open = null;
      note?.();
      note = null;
    };
    async function openChat() {
      const e = entry();
      if (e === "hidden" || !host) return "hidden";
      if (e === "note") {
        note?.();
        note = pageRealmNote(doc, d.origin, () => store.set(host, "never"));
        return "note";
      }
      if (open) {
        close();
        return "closed";
      }
      if (busy) return "busy";
      busy = true;
      try {
        if (!allowedHere(store, once, host)) {
          const choice = await prompt(host);
          if (!applyChoice(store, once, host, choice))
            return choice === "never" ? "never" : "denied";
        }
        if (!(await askFlag(d))) {
          d.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on: false, at: d.now?.() ?? Date.now() }));
          return "off";
        }
        const shell = (d.frame ?? frameShell)({
          doc,
          win,
          origin: d.origin,
          label: `${host}${d.path ?? location.pathname}`.slice(0, 300),
          ticket,
          gripLabel: EMBED_STRINGS[embedLang()].grip,
          pos: {
            get: () => {
              const p = d.getValue(PARTNER_POS_KEY, null);
              return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
            },
            set: (p) => d.setValue(PARTNER_POS_KEY, { x: Math.round(p.x), y: Math.round(p.y) }),
          },
        });
        let loads = 0;
        shell.iframe.addEventListener("load", () => {
          if (++loads > 1) {
            report("pill-chat-navigated", host);
            if (open === shell) close();
            else shell.destroy();
          }
        });
        open = shell;
        const how = await shell.result;
        report("pill-chat-frame", `${how} ${host}`);
        if (how === "ready" && open === shell) return "ready";
        if (open === shell) open = null;
        shell.destroy();
        note?.();
        note = blockedNote({ doc, win, strings, origin: d.origin });
        return "blocked";
      } finally {
        busy = false;
      }
    }
    function manage(onChange) {
      return sitesDialog({ doc, win, strings, store, onChange });
    }
    return {
      entry,
      open: openChat,
      close,
      manage,
      strings,
      isOpen: () => !!open,
      flagOn: () => top && flagMirrorOn(d.getValue(PILLCHAT_ON_KEY, null)),
    };
  }

  // lib/review-filters.ts
  var REVIEW_FILTERS_KEY = "lk:review-filters";
  var REVIEW_FILTERS_EVENT = "lk:review-filters-changed";
  function parseFilters(raw) {
    if (typeof raw !== "string" || !raw) return null;
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  function deviceFilters(own, isMobile, accountCopy) {
    return parseFilters(own) ?? (isMobile ? (accountCopy ?? []) : []);
  }
  function mirrorReviewFilters(store, setValue) {
    try {
      const raw = store.getItem(REVIEW_FILTERS_KEY);
      if (parseFilters(raw)) setValue(REVIEW_FILTERS_KEY, raw);
    } catch {}
  }

  // src/lianki.user.ts
  var US = userscriptStrings();
  if (window.self === window.top) {
    globalThis.unload_Lianki?.();
    globalThis.unload_Lianki = main();
  } else {
    installFrameKeyRelay();
  }
  var KEY_RELAY = "lianki:hotkey";
  function isChildFrame(source) {
    for (let i = 0; i < window.frames.length; i++) {
      if (window.frames[i] === source) return true;
    }
    return false;
  }
  function relayPayload(e) {
    return {
      type: KEY_RELAY,
      code: e.code,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    };
  }
  function installFrameKeyRelay() {
    document.addEventListener(
      "keydown",
      (e) => {
        window.parent.postMessage(relayPayload(e), "*");
      },
      true,
    );
    window.addEventListener("message", (e) => {
      if (e.data?.type === KEY_RELAY && isChildFrame(e.source)) {
        window.parent.postMessage(e.data, "*");
      }
    });
  }
  var SRCDOC_RELAY_FLAG = "liankiRelay";
  var RELAY_NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function srcdocRelaySource(frameId) {
    const head = 'type:"' + KEY_RELAY + '",nonce:"' + RELAY_NONCE + '",frameId:"' + frameId + '"';
    return (
      "<script>(function(){try{if(window.__liankiRelay)return;window.__liankiRelay=1;" +
      "parent.postMessage({" +
      head +
      ',code:"__alive"},"*");' +
      'document.addEventListener("keydown",function(e){try{parent.postMessage({' +
      head +
      ",code:e.code,altKey:e.altKey,ctrlKey:e.ctrlKey,metaKey:e.metaKey,shiftKey:e.shiftKey" +
      '},"*")}catch(_){}},true)}catch(_){}})()<' +
      "/script>"
    );
  }
  var liveRelays = new Set();
  var frameSeq = 0;
  function installSrcdocRelays() {
    if (document.documentElement.dataset.liankiExt) return () => {};
    const MAX_INJECTS = 2;
    const MAX_SRCDOC = 512 * 1024;
    const attempts = new WeakMap();
    const inject = (f) => {
      const src = f.getAttribute("srcdoc") || "";
      if (src.length < 200) return;
      if (src.length > MAX_SRCDOC) return;
      const n = attempts.get(f) ?? 0;
      if (n >= MAX_INJECTS) return;
      attempts.set(f, n + 1);
      const id = `${RELAY_NONCE}-${++frameSeq}`;
      f.dataset[SRCDOC_RELAY_FLAG] = id;
      try {
        f.setAttribute("srcdoc", srcdocRelaySource(id) + stripRelay(src));
      } catch {}
    };
    const sweep = () => {
      for (const f of document.querySelectorAll("iframe[srcdoc]")) {
        const id = f.dataset[SRCDOC_RELAY_FLAG];
        if (!id || !(f.getAttribute("srcdoc") || "").includes(id)) {
          inject(f);
          continue;
        }
        if (liveRelays.has(id)) continue;
        inject(f);
      }
    };
    window.addEventListener("message", (e) => {
      if (e.data?.type === KEY_RELAY && e.data.nonce === RELAY_NONCE && e.data.code === "__alive") {
        liveRelays.add(e.data.frameId);
      }
    });
    sweep();
    const observer = new MutationObserver(sweep);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributeFilter: ["srcdoc"],
    });
    const timer = setTimeout(sweep, 4000);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }
  function stripRelay(src) {
    const end = src.indexOf("</" + "script>");
    return src.startsWith("<script>(function(){try{if(window.__liankiRelay)") && end !== -1
      ? src.slice(end + 9)
      : src;
  }
  function compareHLC(a, b) {
    if (!a) return -1;
    if (!b) return 1;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.counter !== b.counter) return a.counter - b.counter;
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
      deviceId,
    };
  }
  function getOrCreateDeviceId() {
    let deviceId = GM_getValue("lk:deviceId", "");
    if (!deviceId) {
      deviceId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 3) | 8;
        return v.toString(16);
      });
      GM_setValue("lk:deviceId", deviceId);
    }
    return deviceId;
  }
  var CARD_PREFIX = "lk:c:";
  var INDEX_KEY = "lk:card-index";
  function hashUrl(url) {
    let h = 5381;
    for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(8, "0");
  }
  function isPermanentSyncFailure(status) {
    if (status === 401 || status === 403 || status === 408 || status === 429) return false;
    return status >= 400 && status < 500;
  }
  function originOf(url) {
    try {
      const o = new URL(url).origin;
      return o === "null" ? null : o;
    } catch {
      return null;
    }
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
      if (c._url !== url) return null;
      return c.deletedAt ? null : c;
    }
    setCard(url, note, hlc, dirty = false) {
      const hash = hashUrl(url);
      const key = CARD_PREFIX + hash;
      const idx = this._index();
      const pos = idx.findIndex((e) => e.url === url);
      const entry = { url, due: note.card.due, hash };
      try {
        GM_setValue(key, JSON.stringify({ _url: url, note, hlc, dirty }));
      } catch (err) {
        console.error("[Lianki] could not store card locally:", url, err);
        return false;
      }
      if (pos >= 0) idx[pos] = entry;
      else idx.push(entry);
      this._saveIndex(idx);
      return true;
    }
    deleteCard(url) {
      const hash = hashUrl(url);
      const prev = this.getEntry(url);
      const idx = this._index();
      const pos = idx.findIndex((e) => e.url === url);
      const entry = { url, due: new Date(0).toISOString(), hash, del: 1 };
      if (pos >= 0) idx[pos] = entry;
      else idx.push(entry);
      this._saveIndex(idx);
      GM_setValue(
        CARD_PREFIX + hash,
        JSON.stringify({
          _url: url,
          note: null,
          hlc: newHLC(getOrCreateDeviceId(), prev?.hlc ?? null),
          dirty: true,
          deletedAt: Date.now(),
        }),
      );
    }
    restoreCard(url) {
      const hash = hashUrl(url);
      const prev = this.getEntry(url);
      if (!prev?.del) return false;
      const idx = this._index();
      const pos = idx.findIndex((e) => e.url === url);
      const entry = { url, due: new Date().toISOString(), hash };
      if (pos >= 0) idx[pos] = entry;
      else idx.push(entry);
      this._saveIndex(idx);
      GM_deleteValue(CARD_PREFIX + hash);
      return true;
    }
    deleteAllCards() {
      const idx = this._index();
      let n = 0;
      for (const e of idx) {
        if (e.del) continue;
        this.deleteCard(e.url);
        n++;
      }
      return n;
    }
    getEntry(url) {
      const raw = GM_getValue(CARD_PREFIX + hashUrl(url), "");
      if (!raw) return null;
      const c = JSON.parse(raw);
      return c._url === url ? c : null;
    }
    isDeleted(url) {
      const e = this.getEntry(url);
      return !!(e && (e.del || e.deletedAt));
    }
    purgeExpiredTombstones(maxAgeMs = 90 * 86400000) {
      const now = Date.now();
      const idx = this._index();
      const keep = [];
      let removed = 0;
      for (const e of idx) {
        if (e.del) {
          const rec = this.getEntry(e.url);
          if (!rec || now - (rec.deletedAt ?? 0) > maxAgeMs) {
            GM_deleteValue(CARD_PREFIX + e.hash);
            removed++;
            continue;
          }
        }
        keep.push(e);
      }
      if (removed) this._saveIndex(keep);
      return removed;
    }
    getAllCards() {
      return this._index()
        .filter((e) => !e.del)
        .map((e) => {
          const raw = GM_getValue(CARD_PREFIX + e.hash, "");
          return raw ? { url: e.url, ...JSON.parse(raw) } : null;
        })
        .filter(Boolean);
    }
    getDueCards(limit = 10, preferOrigin = null, order = "newest") {
      const now = new Date();
      const onOrigin = (e) => (preferOrigin !== null && originOf(e.url) === preferOrigin ? 1 : 0);
      const dir = order === "newest" ? -1 : 1;
      return this._index()
        .filter((e) => !e.del && new Date(e.due) <= now)
        .sort((a, b) => onOrigin(b) - onOrigin(a) || dir * (new Date(a.due) - new Date(b.due)))
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
  function drainPurgeQueue(cs) {
    let req;
    try {
      const raw = localStorage.getItem("lk:purge");
      if (!raw) return 0;
      req = JSON.parse(raw);
    } catch {
      return 0;
    }
    let removed = 0;
    try {
      if (req?.all) {
        removed = cs.deleteAllCards();
      } else if (Array.isArray(req?.urls)) {
        for (const url of req.urls) {
          if (cs.getCard(url)) removed++;
          cs.deleteCard(url);
        }
      }
      localStorage.removeItem("lk:purge");
    } catch (err) {
      console.error("[Lianki] purge failed:", err);
      return removed;
    }
    if (removed) console.log(`[Lianki] Purged ${removed} deleted cards from local storage`);
    return removed;
  }
  async function syncToSiteDB() {
    const cs = new GMCardStorage();
    drainPurgeQueue(cs);
    cs.purgeExpiredTombstones();
    const index = cs._index().filter((e) => !e.del);
    const now = new Date();
    const dueCount = index.filter((e) => new Date(e.due) <= now).length;
    localStorage.setItem(
      "lk:status",
      JSON.stringify({
        version: GM_info?.script?.version ?? "?",
        cardCount: index.length,
        dueCount,
        lastSync: Date.now(),
      }),
    );
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("lianki-keyval", 1);
        req.onupgradeneeded = (e) => e.target.result.createObjectStore("keyval");
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
      const existingKeys = await new Promise((resolve) => {
        const req = db.transaction("keyval", "readonly").objectStore("keyval").getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      const tx = db.transaction("keyval", "readwrite");
      const store = tx.objectStore("keyval");
      const live = new Set(index.map((e) => "card:" + e.url));
      for (const key of existingKeys) {
        if (typeof key === "string" && key.startsWith("card:") && !live.has(key)) store.delete(key);
      }
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
      console.error("[Lianki] site DB sync FAILED:", err);
    }
  }

  class LocalFSRS {
    constructor(params = null) {
      this.Rating = Rating;
      this.params = params || generatorParameters({});
      this.scheduler = fsrs(this.params);
    }
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
        state: 0,
        last_review: now,
      };
    }
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
    window.LIANKI_USERSCRIPT_INSTALLED = true;
    const ORIGIN = (() => {
      try {
        const u = new URL(GM_info?.script?.downloadURL || "");
        if (u.hostname === "www.lianki.com") u.hostname = "lianki.com";
        return u.origin;
      } catch {
        return "https://lianki.com";
      }
    })();
    function stripFragment(href) {
      const i = href.indexOf("#");
      return i === -1 ? href : href.slice(0, i);
    }
    function normalizeUrl(href) {
      try {
        const u = new URL(href);
        if (u.hostname === "youtu.be") {
          const id = u.pathname.slice(1);
          u.hostname = "www.youtube.com";
          u.pathname = "/watch";
          u.searchParams.set("v", id);
        }
        if (u.hostname.startsWith("m.")) u.hostname = "www." + u.hostname.slice(2);
        if (u.hostname.endsWith("youtube.com") && u.pathname === "/watch")
          u.searchParams.delete("index");
        for (const p of [
          "si",
          "pp",
          "feature",
          "ref",
          "source",
          "theme",
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
    const originHost = new URL(ORIGIN).hostname;
    if (location.hostname === originHost || location.hostname === "www." + originHost) {
      mirrorPartnerSwitch(localStorage, GM_setValue);
      mirrorPillChatFlag({
        origin: ORIGIN,
        gmFetch,
        getValue: GM_getValue,
        setValue: GM_setValue,
      }).catch(() => {});
      const mirrorFilters = () => mirrorReviewFilters(localStorage, GM_setValue);
      mirrorFilters();
      window.addEventListener(REVIEW_FILTERS_EVENT, mirrorFilters);
      setTimeout(() => syncToSiteDB(), 500);
      return () => {};
    }
    const ac = new AbortController();
    const { signal } = ac;
    const intervals = [];
    const addInterval = (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.push(id);
      return id;
    };
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    let userPreferences = {
      mobileExcludePatterns: [],
    };
    const reviewOrder = () => (userPreferences?.reviewOrder === "oldest" ? "oldest" : "newest");
    const watchTrackingOn = () => userPreferences?.watchTracking !== false;
    const cleanedTitle = (title, url) =>
      cleanTitle(title, { url, rules: activeTitleRules(userPreferences?.titleRules) });
    const pageTitle = () => cleanedTitle(document.title, location.href);
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
      notesSynced: true,
    };
    let fab = null;
    const liChat = pillChat({
      origin: ORIGIN,
      gmFetch,
      getValue: GM_getValue,
      setValue: GM_setValue,
      info: GM_info,
      report: (what, detail) => console.debug(`[Lianki] ${what}: ${detail}`),
    });
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
      if (updatePrompted) return;
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
        if (token) headers["Authorization"] = `Bearer ${token}`;
        GM_xmlhttpRequest({
          method: (opts.method || "GET").toUpperCase(),
          url: String(url),
          headers,
          data: opts.body ?? undefined,
          withCredentials: opts.credentials === "include",
          ...(opts.timeout ? { timeout: opts.timeout } : {}),
          onload(resp) {
            const hdrs = {};
            for (const line of resp.responseHeaders.split(`\r
`)) {
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
          ontimeout() {
            reject(new Error("Request timed out"));
          },
          onabort() {
            reject(new Error("Request aborted"));
          },
        });
      });
    }
    function storeBadge(store) {
      if (store === "cloud") return { icon: "☁️", title: US.syncedCloud };
      if (store === "offline") {
        return { icon: "\uD83D\uDCF4", title: US.savedOffline };
      }
      return {
        icon: "\uD83D\uDCBE",
        title: US.savedLocal,
      };
    }
    function dueCountFromIndex(index, now) {
      if (!Array.isArray(index)) return 0;
      const t = now instanceof Date ? now.getTime() : Date.now();
      return index.filter((e) => e && !e.del && new Date(e.due).getTime() <= t).length;
    }
    let cardStore = "local";
    const markStoreFromError = (err) => {
      if (!err?.status) cardStore = "offline";
    };
    const api = (path, opts = {}) =>
      gmFetch(`${ORIGIN}${path}`, { credentials: "include", ...opts })
        .then((r) => {
          cardStore = r.status === 401 || r.status === 403 ? "local" : "cloud";
          const what = `${(opts.method || "GET").toUpperCase()} ${ORIGIN}${path}`;
          if (r.status === 401) {
            const e = new Error(`Login required (${what})`);
            e.status = 401;
            throw e;
          }
          if (!r.ok) {
            const status = r.status;
            return r
              .json()
              .catch(() => null)
              .then((body) => {
                const detail = body?.errorId ? `Error ID: ${body.errorId}` : body?.error;
                const e = new Error(`HTTP ${status} — ${what}${detail ? ` — ${detail}` : ""}`);
                e.status = status;
                e.body = body;
                if (detail) e.details = detail;
                throw e;
              });
          }
          checkVersion(r);
          return r.json();
        })
        .catch((err) => {
          markStoreFromError(err);
          throw err;
        });
    const loggedOnce = new Set();
    const warnOnce = (key, ...args) => {
      if (loggedOnce.has(key)) return;
      loggedOnce.add(key);
      console.warn(...args);
    };
    const isAuthError = (err) =>
      err?.status === 401 || /Login required/i.test(String(err?.message));
    const logFail = (key, doing, err) => {
      if (isAuthError(err))
        warnOnce(`auth:${key}`, `[Lianki] Not signed in — ${doing} is local-only.`);
      else console.error(`[Lianki] ${doing} FAILED:`, err);
    };
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
    const noteKey = (url) => `lk:note:${url}`;
    const addNote = (url, title) =>
      gmCache(noteKey(url), 10 * 60 * 1000, () =>
        api("/api/fsrs/add", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, title }),
        }),
      );
    const buildExcludeDomainsParam = () => {
      const patterns = deviceFilters(
        GM_getValue(REVIEW_FILTERS_KEY, ""),
        isMobile,
        userPreferences.mobileExcludePatterns,
      );
      const values = patterns
        .filter((p) => p && p.enabled !== false && !p.isRegex)
        .filter((p) => p.type === "domain" || p.type === "url")
        .map((p) => String(p.pattern || "").trim())
        .filter((p) => p && !p.includes(","));
      if (values.length === 0) return "";
      return `&excludeDomains=${values.map(encodeURIComponent).join(",")}`;
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
    const restoreNote = (url, title) =>
      api("/api/fsrs/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title, restore: true }),
      });
    const deleteNote = (id, url) =>
      api(
        `/api/fsrs/delete?id=${encodeURIComponent(id)}` +
          `${url ? `&url=${encodeURIComponent(url)}` : ""}${buildExcludeDomainsParam()}`,
      );
    const getNextUrl = () => {
      const excludeUrl = `&excludeUrl=${encodeURIComponent(normalizeUrl(location.href))}`;
      return api(`/api/fsrs/next-url?${buildExcludeDomainsParam().slice(1)}${excludeUrl}`);
    };
    const btn = (bg, extra = "") =>
      `all:initial;display:inline-block;box-sizing:border-box;background:${bg};color:${bg === "transparent" ? "var(--lk-fg)" : "#eee"};border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;min-width:60px;line-height:1.5;text-align:center;${extra}`;
    function prefetchNextPage(pageUrl) {
      if (!pageUrl) return;
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
        WebkitTouchCallout: "none",
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
      const slowerBtn = makeBtn("⏪", US.slower, () => pardon(-3, 0.7));
      const liankiBtn = makeBtn("\uD83D\uDD16", US.liCards, () =>
        dialog ? closeDialog() : openDialog(),
      );
      const fasterBtn = makeBtn("⏩", US.faster, () => pardon(0, 1.2));
      const makeSeparator = () => {
        const sep = document.createElement("div");
        sep.style.cssText =
          "width:1px;height:24px;background:rgba(255,255,255,0.15);align-self:center;";
        return sep;
      };
      container.append(slowerBtn, makeSeparator(), liankiBtn, makeSeparator(), fasterBtn);
      const liSep = makeSeparator();
      const liBtn = document.createElement("button");
      liBtn.type = "button";
      liBtn.textContent = "Li";
      liBtn.title = liChat.strings.liTitle;
      liBtn.setAttribute("aria-label", liChat.strings.liTitle);
      liBtn.style.cssText = BTN_BASE;
      liBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isDragged || !e.isTrusted) return;
        liChat
          .open()
          .then(updateLiEntry)
          .catch((err) => console.error("[Lianki] Li chat failed:", err));
      });
      const updateLiEntry = () => {
        const show = liChat.entry() !== "hidden" ? "" : "none";
        liSep.style.display = show;
        liBtn.style.display = show;
      };
      updateLiEntry();
      document.addEventListener(
        "visibilitychange",
        () => document.visibilityState === "visible" && updateLiEntry(),
        { signal },
      );
      container.append(liSep, liBtn);
      if (liChat.flagOn() && typeof GM_registerMenuCommand === "function")
        GM_registerMenuCommand(liChat.strings.sitesMenu, () => {
          const m = liChat.manage(() => updateLiEntry());
          m.closed.then(updateLiEntry);
        });
      let pageHasCard = false;
      const updateLiankiIcon = () => {
        let hasCard = false;
        try {
          hasCard = offlineReady && !!cardStorage.getCard(normalizeUrl(location.href));
        } catch {}
        pageHasCard = hasCard;
        if (swipeRating) return;
        const icon = hasCard ? "\uD83D\uDCD7" : "\uD83D\uDD16";
        if (liankiBtn.textContent !== icon) {
          liankiBtn.textContent = icon;
          liankiBtn.title = hasCard ? US.reviewCard : US.addCard;
        }
      };
      addInterval(updateLiankiIcon, 1000);
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
        if (atLeft && atTop) radius = "0 999px 999px 0";
        else if (atRight && atTop) radius = "999px 0 0 999px";
        else if (atLeft && atBottom) radius = "0 999px 999px 0";
        else if (atRight && atBottom) radius = "999px 0 0 999px";
        else if (atLeft) radius = "0 999px 999px 0";
        else if (atRight) radius = "999px 0 0 999px";
        else if (atTop) radius = "0 0 999px 999px";
        else if (atBottom) radius = "999px 999px 0 0";
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
        subtree: true,
      });
      window.addEventListener("resize", constrainPosition, { signal });
      const LONG_PRESS_MS = 400;
      let dragging = false;
      let armed = false;
      let pressTimer = 0;
      let moved = false;
      const SWIPE_MIN = 40;
      const SWIPE_UP = -1;
      const SWIPE_RATINGS = { left: 1, down: 2, right: 4, up: SWIPE_UP };
      const RATING_LABELS = { 1: US.again, 2: US.hard, 4: US.easy, [SWIPE_UP]: US.open };
      let swiping = false;
      let swipeRating = 0;
      const swipeDirection = (dx, dy) => {
        if (Math.hypot(dx, dy) < SWIPE_MIN) return null;
        if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
        return dy < 0 ? "up" : "down";
      };
      const quickReview = async (rating) => {
        if (!dialog) openDialog();
        for (let i = 0; i < 50 && state?.phase !== "reviewing"; i++)
          await new Promise((r) => setTimeout(r, 100));
        if (state?.phase === "reviewing") await doReview(rating);
      };
      let startX = 0,
        startY = 0,
        startLeft = 0,
        startTop = 0;
      const initDrag = (clientX, clientY) => {
        isDragged = false;
        armed = false;
        swiping = false;
        swipeRating = 0;
        updateLiankiIcon();
        dragging = true;
        startX = clientX;
        startY = clientY;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          if (!dragging) return;
          armed = true;
          isDragged = true;
          container.style.transform = "scale(1.08)";
          container.style.boxShadow = "0 4px 16px rgba(0,0,0,0.55)";
          navigator.vibrate?.(20);
        }, LONG_PRESS_MS);
      };
      const moveDrag = (clientX, clientY) => {
        if (!dragging) return;
        const dx = clientX - startX,
          dy = clientY - startY;
        if (!armed) {
          if (!swiping && Math.abs(dx) + Math.abs(dy) > 6) {
            clearTimeout(pressTimer);
            if (pageHasCard) {
              swiping = true;
              isDragged = true;
            } else dragging = false;
          }
          if (swiping) {
            const dir = swipeDirection(dx, dy);
            swipeRating = dir ? SWIPE_RATINGS[dir] : 0;
            liankiBtn.textContent = swipeRating ? RATING_LABELS[swipeRating] : "\uD83D\uDCD7";
          }
          return;
        }
        if (!moved) {
          moved = true;
          const r = container.getBoundingClientRect();
          container.style.right = "auto";
          container.style.bottom = "auto";
          startLeft = clientX - r.width / 2;
          startTop = clientY - r.height / 2;
          startX = clientX;
          startY = clientY;
        }
        const r = container.getBoundingClientRect();
        const newLeft = startLeft + (clientX - startX);
        const newTop = startTop + (clientY - startY);
        container.style.left = Math.max(0, Math.min(window.innerWidth - r.width, newLeft)) + "px";
        container.style.top = Math.max(0, Math.min(window.innerHeight - r.height, newTop)) + "px";
        updateBorderRadius();
      };
      const stopDrag = () => {
        clearTimeout(pressTimer);
        if (moved) {
          GM_setValue(
            "lianki_pos",
            JSON.stringify({ x: parseInt(container.style.left), y: parseInt(container.style.top) }),
          );
          updateBorderRadius();
        }
        if (armed) {
          container.style.transform = "";
          container.style.boxShadow = "0 2px 8px rgba(0,0,0,0.4)";
        }
        const rating = swipeRating;
        dragging = false;
        armed = false;
        moved = false;
        swiping = false;
        swipeRating = 0;
        updateLiankiIcon();
        if (rating === SWIPE_UP) dialog || openDialog();
        else if (rating) quickReview(rating);
      };
      container.addEventListener(
        "touchstart",
        (e) => initDrag(e.touches[0].clientX, e.touches[0].clientY),
        { passive: true },
      );
      container.addEventListener(
        "touchmove",
        (e) => {
          if (armed || swiping) e.preventDefault();
          if (dragging) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        },
        { passive: false },
      );
      container.addEventListener("touchend", stopDrag, { passive: true });
      container.addEventListener("touchcancel", stopDrag, { passive: true });
      container.addEventListener("contextmenu", (e) => e.preventDefault());
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
        --lk-error: #ff8a80;
        --lk-success: #69f0ae;
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
          --lk-error: #b71c1c;
          --lk-success: #1b5e20;
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
        marginBottom: "16px",
      });
      const titleSpan = document.createElement("span");
      Object.assign(titleSpan.style, { fontWeight: "700", fontSize: "16px" });
      titleSpan.textContent = "\uD83D\uDD16 LiCards";
      const badge = document.createElement("span");
      const { icon, title } = storeBadge(cardStore);
      const due = offlineReady ? dueCountFromIndex(cardStorage._index(), new Date()) : null;
      badge.textContent = due === null ? icon : `${icon} ${fillUs(US.due, { n: due })}`;
      badge.title = due === null ? title : `${title} · ${fillUs(US.due, { n: due })}`;
      Object.assign(badge.style, {
        marginLeft: "8px",
        fontSize: "12px",
        fontWeight: "400",
        color: "var(--lk-muted)",
        whiteSpace: "nowrap",
      });
      titleSpan.appendChild(badge);
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
        spinRow.appendChild(document.createTextNode(US.adding));
        const urlDiv = document.createElement("div");
        Object.assign(urlDiv.style, {
          color: "var(--lk-muted)",
          fontSize: "12px",
          wordBreak: "break-all",
        });
        urlDiv.textContent = normalizeUrl(location.href);
        wrap.appendChild(spinRow);
        wrap.appendChild(urlDiv);
        dialog.appendChild(wrap);
      } else if (phase === "error") {
        const errDiv = document.createElement("div");
        errDiv.style.color = "var(--lk-error)";
        errDiv.textContent = friendlyError(error, US);
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
        loginBtn.textContent = US.signIn;
        loginBtn.addEventListener("click", () => window.open(ORIGIN, "_blank"));
        btnRow.appendChild(loginBtn);
        const copyBtn = document.createElement("button");
        copyBtn.setAttribute("style", btn("#444"));
        copyBtn.textContent = US.copyError;
        copyBtn.addEventListener("click", () => {
          const parts = [
            `Error: ${error}`,
            `Page: ${location.href}`,
            `Origin: ${ORIGIN}`,
            `Version: ${CURRENT_VERSION}`,
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
          copyBtn.textContent = US.copied;
          setTimeout(() => {
            copyBtn.textContent = US.copyError;
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
        bold.textContent = pageTitle() || location.href;
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
          b.appendChild(
            document.createTextNode(
              [US.again, US.hard, US.good, US.easy][Number(o.rating) - 1] ?? o.label,
            ),
          );
          b.appendChild(document.createElement("br"));
          const small = document.createElement("small");
          Object.assign(small.style, { color: "rgba(255,255,255,0.9)", fontSize: "11px" });
          small.textContent = o.due;
          b.appendChild(small);
          b.addEventListener("click", () => doReview(Number(o.rating)));
          btnRow.appendChild(b);
        }
        dialog.appendChild(btnRow);
        const deleteBtn = document.createElement("button");
        deleteBtn.setAttribute("style", btn("#7a2a2a"));
        deleteBtn.textContent = US.delete;
        deleteBtn.addEventListener("click", doDelete);
        dialog.appendChild(deleteBtn);
        const hints = document.createElement("div");
        Object.assign(hints.style, { marginTop: "14px", opacity: ".6", fontSize: "11px" });
        hints.textContent = US.hints;
        dialog.appendChild(hints);
        const notesRow = document.createElement("div");
        Object.assign(notesRow.style, { marginTop: "10px", position: "relative" });
        const notesInput = document.createElement("input");
        notesInput.type = "text";
        notesInput.maxLength = 128;
        notesInput.placeholder = US.notes;
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
      } else if (phase === "deleted") {
        const msgDiv = document.createElement("div");
        Object.assign(msgDiv.style, { fontSize: "15px", marginBottom: "12px" });
        msgDiv.textContent = message;
        dialog.appendChild(msgDiv);
        const restoreBtn = document.createElement("button");
        restoreBtn.textContent = US.restore;
        restoreBtn.setAttribute("style", btn("#2d6a4f"));
        restoreBtn.addEventListener("click", doRestore);
        dialog.appendChild(restoreBtn);
        const hint = document.createElement("div");
        Object.assign(hint.style, {
          fontSize: "11px",
          color: "var(--lk-muted)",
          marginTop: "8px",
        });
        hint.textContent = US.restoreHint;
        dialog.appendChild(hint);
      } else if (phase === "reviewed") {
        const msgDiv = document.createElement("div");
        Object.assign(msgDiv.style, { color: "var(--lk-success)", fontSize: "15px" });
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
          gap: "4px",
        });
        const queue = queueStorage.getQueue();
        if (!navigator.onLine) indicator.textContent = `\uD83D\uDCF4 ${US.offline}`;
        else if (syncInProgress) indicator.textContent = `\uD83D\uDD04 ${US.syncing}`;
        else if (queue.length > 0) indicator.textContent = `⏳ ${queue.length}`;
        else indicator.textContent = "✓";
        dialog.appendChild(indicator);
      }
    }
    function openDialog() {
      if (dialog) return;
      dialog = mountDialog();
      state = { phase: "adding", noteId: null, options: null, error: null, message: null };
      prefetchedNextUrl = null;
      renderDialog();
      dialog.focus();
      keepFocusInDialog();
      const url = normalizeUrl(location.href);
      addNote(url, pageTitle())
        .then((note) => {
          state.noteId = note._id;
          state.notes = note.notes ?? "";
          state.notesSynced = true;
          getNextUrl()
            .then((data) => {
              prefetchedNextUrl = data.url;
              if (data.url) prefetchNextPage(data.url);
            })
            .catch(() => {});
          if (note.options) {
            return { options: note.options };
          }
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
    function keepFocusInDialog() {
      let grabs = 0;
      document.addEventListener(
        "focusin",
        (e) => {
          if (!dialog || grabs >= 10) return;
          if (e.target === dialog._shadowHost || dialog.contains(e.target)) return;
          grabs++;
          dialog.focus();
        },
        { signal },
      );
    }
    function closeDialog() {
      if (!dialog) return;
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
      if (state.phase !== "reviewing" || !state.noteId) return;
      try {
        const result = await submitReview(state.noteId, rating);
        prefetchedNextUrl = result.nextUrl ?? null;
        if (result.nextUrl) prefetchNextPage(result.nextUrl);
        const opt = state.options.find((o) => Number(o.rating) === rating);
        await afterReview(fillUs(US.reviewed, { due: opt?.due ?? "?" }));
      } catch (err) {
        state.phase = "error";
        state.error = err.message;
        state.errorDetails = err.details ?? null;
        renderDialog();
      }
    }
    async function doRestore() {
      const url = normalizeUrl(location.href);
      try {
        if (offlineReady) cardStorage.restoreCard(url);
        gmCacheInvalidate(noteKey(url));
        await restoreNote(url, pageTitle());
        closeDialog();
        setTimeout(openDialog, 0);
      } catch (err) {
        state.phase = "error";
        state.error = `Restore failed: ${err?.message ?? err}`;
        renderDialog();
      }
    }
    async function doDelete() {
      if (state.phase !== "reviewing" || !state.noteId) return;
      const url = normalizeUrl(location.href);
      try {
        if (offlineReady) {
          try {
            cardStorage.deleteCard(url);
          } catch (e) {
            console.error("[Lianki] Local delete failed:", e);
          }
        }
        gmCacheInvalidate(noteKey(url));
        if (offlineReady) {
          try {
            const dueCards = cardStorage.getDueCards(2, location.origin, reviewOrder());
            const nextCard = dueCards.find((c) => c.url !== url);
            prefetchedNextUrl = nextCard?.url ?? null;
            if (prefetchedNextUrl) prefetchNextPage(prefetchedNextUrl);
          } catch (e) {
            prefetchedNextUrl = null;
          }
        }
        if (!state.noteId.startsWith("local:")) {
          try {
            const result = await deleteNote(state.noteId, url);
            if (result.nextUrl) {
              prefetchedNextUrl = result.nextUrl;
              prefetchNextPage(result.nextUrl);
            }
          } catch (err) {
            console.error("[Lianki] Server delete failed:", err);
          }
        } else if (offlineReady) {
          queueStorage.addToQueue("delete", { url, noteId: state.noteId }, newHLC(deviceId));
        }
        await afterReview(US.deleted);
      } catch (err) {
        state.phase = "error";
        state.error = err.message;
        state.errorDetails = err.details ?? null;
        renderDialog();
      }
    }
    async function probeUrl(url, timeoutMs = 8000) {
      try {
        const r = await api(`/api/fsrs/probe?url=${encodeURIComponent(url)}`, {
          timeout: timeoutMs,
        });
        return {
          ok: r?.reachable !== false,
          finalUrl: r?.finalUrl,
          status: r?.status,
          reason: r?.reason,
        };
      } catch {
        return { ok: true, reason: "unknown" };
      }
    }
    function markUnreachable(url) {
      try {
        const rec = cardStorage?.getCard?.(url);
        if (!rec?.note) return;
        const note = { ...rec.note, unreachableAt: Date.now() };
        cardStorage.setCard(url, note, rec.hlc, rec.dirty ?? false);
      } catch {}
    }
    async function afterReview(doneMessage) {
      state.phase = "reviewed";
      let nextUrl = prefetchedNextUrl;
      let nextTitle = null;
      prefetchedNextUrl = null;
      if (!nextUrl) {
        state.message = US.loadingNext;
        renderDialog();
        const data = await getNextUrl().catch(() => ({ url: null, title: null }));
        nextUrl = data.url;
        nextTitle = data.title;
        if (nextUrl) {
          prefetchNextPage(nextUrl);
          state.message = fillUs(US.opening, {
            title: (nextTitle && cleanedTitle(nextTitle, nextUrl)) || nextUrl,
          });
          renderDialog();
        }
      }
      if (nextUrl && /^https?:\/\//.test(nextUrl)) {
        const probe = await probeUrl(nextUrl);
        if (probe.ok && probe.finalUrl && probe.finalUrl !== nextUrl) {
          console.log("[Lianki] Next card likely redirects:", nextUrl, "->", probe.finalUrl);
        }
        if (!probe.ok) {
          console.warn("[Lianki] Next card is unreachable, skipping:", nextUrl);
          markUnreachable(nextUrl);
          state.message = fillUs(US.skipped, { url: nextUrl });
          renderDialog();
          prefetchedNextUrl = null;
          const again = await getNextUrl().catch(() => ({ url: null }));
          if (again.url && again.url !== nextUrl) {
            GM_setValue("lk:nav_intended", JSON.stringify({ url: again.url, ts: Date.now() }));
            location.href = again.url;
            return;
          }
          state.message = US.skippedNone;
          renderDialog();
          setTimeout(closeDialog, 3000);
          return;
        }
        console.log("[Lianki] Storing intended URL:", nextUrl);
        GM_setValue("lk:nav_intended", JSON.stringify({ url: nextUrl, ts: Date.now() }));
        const sameDocument = stripFragment(nextUrl) === stripFragment(location.href);
        location.href = nextUrl;
        if (sameDocument) {
          closeDialog();
          setTimeout(openDialog, 0);
        }
      } else {
        state.message = `${doneMessage} — All done!`;
        renderDialog();
        setTimeout(closeDialog, 2000);
      }
    }
    const KEYS = {
      Digit1: () => doReview(1),
      KeyA: () => doReview(1),
      KeyH: () => doReview(1),
      Digit2: () => doReview(2),
      KeyS: () => doReview(2),
      KeyJ: () => doReview(2),
      Digit3: () => doReview(3),
      KeyW: () => doReview(3),
      KeyK: () => doReview(3),
      Digit4: () => doReview(4),
      KeyD: () => doReview(4),
      KeyL: () => doReview(4),
      KeyR: () => (state.phase === "deleted" ? doRestore() : undefined),
      Digit5: () => doDelete(),
      KeyT: () => doDelete(),
      KeyM: () => doDelete(),
      Escape: () => closeDialog(),
    };
    function keyAction(k) {
      if (k.altKey && !k.ctrlKey && !k.metaKey && !k.shiftKey && k.code === "KeyF") {
        return () => (dialog ? closeDialog() : openDialog());
      }
      if (!dialog || state.phase !== "reviewing") return null;
      if (k.altKey || k.ctrlKey || k.metaKey || k.shiftKey) return null;
      return KEYS[k.code] ?? null;
    }
    document.addEventListener(
      "keydown",
      (e) => {
        const action = keyAction(e);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        action();
      },
      { capture: true, signal },
    );
    window.addEventListener(
      "message",
      (e) => {
        if (e.data?.type !== KEY_RELAY || e.data.code === "__alive") return;
        if (e.data.nonce !== RELAY_NONCE && !isChildFrame(e.source)) return;
        keyAction(e.data)?.();
      },
      { signal },
    );
    globalThis.__liankiRelayKey = (k) => keyAction(k)?.();
    installSrcdocRelays();
    (() => {
      let vcid = null;
      document.addEventListener("visibilitychange", trackHandler, { signal });
      function trackHandler() {
        const cb = () => {
          if (!navigator.mediaSession) return;
          navigator.mediaSession.setActionHandler("nexttrack", () => {
            pardon(0, 1.2);
          });
          navigator.mediaSession.setActionHandler("previoustrack", () => {
            pardon(-1.5, 0.9);
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
    function renameLocalCard(oldUrl, newUrl) {
      if (!oldUrl || !newUrl || oldUrl === newUrl) return;
      try {
        const cs = cardStorage ?? new GMCardStorage();
        const from = cs.getCard(oldUrl);
        if (!from) return;
        const to = cs.getCard(newUrl);
        const keepExisting = to && compareHLC(to.hlc, from.hlc) >= 0;
        if (!keepExisting) {
          const note = { ...from.note, url: newUrl };
          cardStorage.setCard(newUrl, note, from.hlc, from.dirty ?? false);
        }
        cardStorage.deleteCard(oldUrl);
        console.log(`[Lianki] Local card moved: ${oldUrl} -> ${newUrl}`);
      } catch (err) {
        console.error("[Lianki] Failed to move local card:", oldUrl, err);
      }
    }
    async function checkRedirect() {
      try {
        const raw = GM_getValue("lk:nav_intended", "");
        if (!raw) return;
        const { url: intendedUrl, ts } = JSON.parse(raw);
        if (Date.now() - ts > 30000) return;
        const actualUrl = location.href;
        if (normalizeUrl(actualUrl) === normalizeUrl(intendedUrl)) {
          GM_setValue("lk:nav_intended", "");
          return;
        }
        console.log("[Lianki] Redirect detected:", intendedUrl, "→", actualUrl);
        const confirmed = confirm(fillUs(US.redirectConfirm, { from: intendedUrl, to: actualUrl }));
        if (!confirmed) {
          console.log("[Lianki] User declined URL update");
          GM_setValue("lk:nav_intended", "");
          return;
        }
        const result = await api("/api/fsrs/update-url", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ oldUrl: intendedUrl, newUrl: actualUrl }),
        });
        console.log("[Lianki] Card URL updated:", result);
        renameLocalCard(intendedUrl, actualUrl);
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
      history.pushState = function (...args) {
        originalPushState.apply(this, args);
        setTimeout(checkRedirect, 100);
      };
      history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        setTimeout(checkRedirect, 100);
      };
      window.addEventListener("popstate", () => setTimeout(checkRedirect, 100), { signal });
    }
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
    const videoSpeedMaps = new WeakMap();
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
      const mergeNearbyMarkers = (time) => {
        if (speedMultiplier === 1) return;
        if (!videoSpeedMaps.has(v)) videoSpeedMaps.set(v, new Map());
        const speedMap = videoSpeedMaps.get(v);
        const MERGE_THRESHOLD = 2;
        for (const [existingTime] of speedMap) {
          if (Math.abs(time - existingTime) < MERGE_THRESHOLD) {
            speedMap.delete(existingTime);
            console.log(
              `[Lianki] Merged marker: ${renderTime(existingTime)} @ ${renderTime(time)}`,
            );
          }
        }
      };
      mergeNearbyMarkers(v.currentTime);
      if (dt !== 0) v.currentTime += dt;
      mergeNearbyMarkers(v.currentTime);
      if (speedMultiplier !== 1) {
        v.playbackRate *= speedMultiplier;
        const speedMap = videoSpeedMaps.get(v);
        speedMap.set(v.currentTime, v.playbackRate);
        console.log(
          `[Lianki] Speed marker: ${renderTime(v.currentTime)} → ${renderSpeed(v.playbackRate)}`,
        );
        const url = normalizeUrl(location.href);
        const markers = Object.fromEntries(speedMap);
        saveLocalMarkers(url, markers, true);
      }
      centerTooltip(
        (dt < 0 ? "<-" : "->") +
          " " +
          renderTime(v.currentTime) +
          " " +
          renderSpeed(v.playbackRate),
      );
      if (wait) await sleep(wait);
      return true;
    }
    window.addEventListener(
      "keydown",
      async (e) => {
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
    function setupVideoSpeedTracking(video) {
      const url = normalizeUrl(location.href);
      (async () => {
        try {
          const local = loadLocalMarkers(url);
          const { markers } = await api(`/api/fsrs/speed-markers?url=${encodeURIComponent(url)}`);
          const merged = { ...local.markers, ...markers };
          saveLocalMarkers(url, merged, false);
          if (!videoSpeedMaps.has(video)) videoSpeedMaps.set(video, new Map());
          const speedMap = videoSpeedMaps.get(video);
          for (const [timestamp, speed] of Object.entries(merged)) {
            speedMap.set(parseFloat(timestamp), speed);
          }
          console.log(`[Lianki] Loaded ${Object.keys(merged).length} speed markers for ${url}`);
        } catch (err) {
          if (isAuthError(err))
            warnOnce(
              "auth:markers",
              "[Lianki] Not signed in — speed markers stay local only.",
              err.message,
            );
          else console.error(`[Lianki] Failed to load speed markers for ${url}:`, err);
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
        const threshold = 0.5;
        if (Math.abs(currentTime - lastCheckedTime) < 0.3) return;
        lastCheckedTime = currentTime;
        for (const [markedTime, targetSpeed] of speedMap) {
          if (Math.abs(currentTime - markedTime) < threshold) {
            if (Math.abs(video.playbackRate - targetSpeed) > 0.01) {
              video.playbackRate = targetSpeed;
              centerTooltip(`Auto-speed: ${renderSpeed(targetSpeed)} @ ${renderTime(markedTime)}`);
              console.log(
                `[Lianki] Auto-adjusted to ${renderSpeed(targetSpeed)} at ${renderTime(currentTime)}`,
              );
            }
            break;
          }
        }
      });
    }
    const WATCH_TICK_MAX_S = 2;
    const WATCH_SESSION_GAP_MS = 30 * 60000;
    const WATCH_MIN_SYNC_S = 60;
    const WATCH_SYNC_MS = 30000;
    const WATCH_SAVE_MS = 5000;
    const WATCH_REQUIRE_AUDIBLE = true;
    const WATCH_REQUIRE_VISIBLE = true;
    const WATCH_DIRTY_KEY = "lk:watch-dirty";
    const WATCH_INDEX_KEY = "lk:watch-index";
    const WATCH_MAX_CACHED = 500;
    const watchDeviceId = getOrCreateDeviceId();
    const watchCacheKey = (url) => `lk:watch:${normalizeUrl(url)}`;
    const isYouTube = () => /(^|\.)youtube\.com$/.test(location.hostname);
    function loadLocalWatch(url) {
      try {
        const raw = GM_getValue(watchCacheKey(url), "");
        if (!raw) return { stats: emptyWatchStats(), dirty: false };
        const c = JSON.parse(raw);
        return { stats: sanitizeWatchStats(c.stats), dirty: !!c.dirty };
      } catch {
        return { stats: emptyWatchStats(), dirty: false };
      }
    }
    const saveLocalWatch = (url, stats, dirty) =>
      GM_setValue(watchCacheKey(url), JSON.stringify({ stats, dirty, savedAt: Date.now() }));
    const watchDirtyList = () => {
      try {
        const list = JSON.parse(GM_getValue(WATCH_DIRTY_KEY, "[]"));
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    };
    const watchDirtyAdd = (url) =>
      GM_setValue(
        WATCH_DIRTY_KEY,
        JSON.stringify([...watchDirtyList().filter((u) => u !== url), url].slice(-200)),
      );
    const watchDirtyDrop = (url) =>
      GM_setValue(WATCH_DIRTY_KEY, JSON.stringify(watchDirtyList().filter((u) => u !== url)));
    function watchIndexTouch(url) {
      let list = [];
      try {
        const parsed = JSON.parse(GM_getValue(WATCH_INDEX_KEY, "[]"));
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
      const next = [...list.filter((u) => u !== url), url];
      for (const stale of next.splice(0, Math.max(0, next.length - WATCH_MAX_CACHED))) {
        if (loadLocalWatch(stale).dirty) next.unshift(stale);
        else GM_deleteValue(watchCacheKey(stale));
      }
      GM_setValue(WATCH_INDEX_KEY, JSON.stringify(next));
    }
    function watchLangFor() {
      let overrides = {};
      try {
        overrides = JSON.parse(GM_getValue("lk:watch-lang", "{}")) || {};
      } catch {}
      if (isYouTube()) {
        const href = document
          .querySelector('ytd-channel-name a[href^="/@"], a.yt-simple-endpoint[href^="/@"]')
          ?.getAttribute("href");
        return (href && overrides[`youtube${href}`]) || undefined;
      }
      const lang = document.documentElement.lang?.trim();
      return overrides[location.hostname] || (lang && lang.length <= 32 ? lang : undefined);
    }
    let watchSyncUnavailable = false;
    let watchAcc = null;
    let watchSavedAt = 0;
    const watchSnapshot = (acc) =>
      mergeWatchStats(acc.base, {
        v: 1,
        by: {
          [watchDeviceId]: {
            wall: Math.round(acc.wall),
            media: Math.round(acc.media),
            sessions: acc.sessions,
            days: acc.days,
            cov: acc.cov.length ? encodeCoverage(acc.cov) : undefined,
            dur: acc.dur,
            lang: acc.lang,
            first: acc.first,
            last: acc.last,
          },
        },
      });
    function persistWatch(acc, force) {
      if (!acc) return;
      const now = Date.now();
      if (!force && now - watchSavedAt < WATCH_SAVE_MS) return;
      watchSavedAt = now;
      acc.title = pageTitle() || acc.title;
      saveLocalWatch(acc.url, watchSnapshot(acc), acc.dirty);
      if (acc.dirty) watchDirtyAdd(acc.url);
      if (!acc.indexed) {
        acc.indexed = true;
        watchIndexTouch(acc.url);
      }
    }
    async function flushWatch(acc = watchAcc) {
      if (watchSyncUnavailable || !acc?.dirty) return;
      persistWatch(acc, true);
      if (acc.wall < WATCH_MIN_SYNC_S) return;
      const stats = watchSnapshot(acc);
      try {
        await api("/api/fsrs/watch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: acc.url, title: acc.title, stats }),
        });
        acc.dirty = false;
        acc.base = stats;
        saveLocalWatch(acc.url, stats, false);
        watchDirtyDrop(acc.url);
      } catch (err) {
        if (/HTTP (404|405|500|501|502)/.test(String(err?.message))) {
          watchSyncUnavailable = true;
          console.warn(
            `[Lianki] Watch sync disabled — ${ORIGIN}/api/fsrs/watch unavailable (${err.message}). ` +
              `Time is still being recorded locally.`,
          );
          return;
        }
        logFail("watch", `watch-time sync for ${acc.url}`, err);
      }
    }
    async function flushPendingWatch(max = 3) {
      if (watchSyncUnavailable) return;
      for (const url of watchDirtyList()
        .filter((u) => u !== watchAcc?.url)
        .slice(0, max)) {
        const { stats, dirty } = loadLocalWatch(url);
        if (!dirty) {
          watchDirtyDrop(url);
          continue;
        }
        try {
          await api("/api/fsrs/watch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url, stats }),
          });
          saveLocalWatch(url, stats, false);
          watchDirtyDrop(url);
        } catch {
          return;
        }
      }
    }
    async function seedWatchFromServer(acc) {
      try {
        const { stats } = await api(`/api/fsrs/watch?url=${encodeURIComponent(acc.url)}`);
        const merged = mergeWatchStats(sanitizeWatchStats(stats), watchSnapshot(acc));
        if (acc !== watchAcc || acc.url !== watchAcc.url) return;
        const mine = merged.by[watchDeviceId] ?? {};
        acc.base = merged;
        acc.wall = Math.max(acc.wall, mine.wall ?? 0);
        acc.media = Math.max(acc.media, mine.media ?? 0);
        acc.sessions = Math.max(acc.sessions, mine.sessions ?? 0);
        for (const [day, secs] of Object.entries(mine.days ?? {}))
          acc.days[day] = Math.max(acc.days[day] ?? 0, secs);
        acc.cov = decodeCoverage(mine.cov);
        acc.first ??= mine.first;
      } catch {}
    }
    function watchAccFor() {
      const url = normalizeUrl(location.href);
      if (watchAcc?.url === url) return watchAcc;
      if (watchAcc) flushWatch(watchAcc);
      const { stats, dirty } = loadLocalWatch(url);
      const mine = stats.by[watchDeviceId] ?? {};
      watchAcc = {
        url,
        base: stats,
        title: pageTitle(),
        wall: mine.wall ?? 0,
        media: mine.media ?? 0,
        sessions: mine.sessions ?? 0,
        days: { ...mine.days },
        cov: decodeCoverage(mine.cov),
        dur: mine.dur,
        lang: mine.lang,
        first: mine.first,
        last: mine.last,
        tick: 0,
        mediaAt: 0,
        activeAt: 0,
        langAt: 0,
        dirty,
        seeded: false,
        indexed: false,
      };
      return watchAcc;
    }
    const isWatchActive = (v) =>
      watchTrackingOn() &&
      !v.paused &&
      !v.ended &&
      v.readyState >= 3 &&
      v.playbackRate > 0 &&
      (!WATCH_REQUIRE_VISIBLE || document.visibilityState === "visible") &&
      (!WATCH_REQUIRE_AUDIBLE || (!v.muted && v.volume > 0)) &&
      !(isYouTube() && document.querySelector(".ad-showing"));
    function watchTick(video) {
      const acc = watchAccFor();
      const now = Date.now();
      if (!isWatchActive(video)) {
        acc.tick = 0;
        return;
      }
      if (Number.isFinite(video.duration) && video.duration > 0) {
        acc.dur = video.duration;
        const buckets = coverageBuckets(acc.dur);
        if (buckets && acc.cov.length * 8 < buckets) {
          const grown = newCoverage(buckets);
          grown.set(acc.cov);
          acc.cov = grown;
        }
      }
      if (acc.lang == null && now - acc.langAt > 5000) {
        acc.langAt = now;
        acc.lang = watchLangFor();
      }
      if (!acc.tick) {
        if (!acc.activeAt || now - acc.activeAt > WATCH_SESSION_GAP_MS) acc.sessions++;
        acc.tick = now;
        acc.activeAt = now;
        acc.mediaAt = video.currentTime;
        acc.first ??= new Date(now).toISOString();
        return;
      }
      const dtWall = (now - acc.tick) / 1000;
      acc.tick = now;
      acc.activeAt = now;
      if (dtWall <= 0 || dtWall > WATCH_TICK_MAX_S) {
        acc.mediaAt = video.currentTime;
        return;
      }
      const dtMedia = video.currentTime - acc.mediaAt;
      if (dtMedia > 0 && dtMedia <= dtWall * video.playbackRate * 1.5 + 0.5) {
        acc.media += dtMedia;
        if (acc.cov.length) markCoverage(acc.cov, acc.mediaAt, video.currentTime);
      }
      acc.mediaAt = video.currentTime;
      acc.wall += dtWall;
      const day = localDayKey(new Date(now));
      acc.days[day] = (acc.days[day] ?? 0) + dtWall;
      acc.last = new Date(now).toISOString();
      acc.dirty = true;
      if (!acc.seeded && acc.wall >= 10) {
        acc.seeded = true;
        seedWatchFromServer(acc);
      }
      persistWatch(acc);
    }
    function setupWatchTracking(video) {
      video.addEventListener("timeupdate", () => watchTick(video));
      const drop = () => {
        if (watchAcc) watchAcc.tick = 0;
      };
      for (const ev of ["pause", "ended", "seeking", "waiting", "ratechange", "play"])
        video.addEventListener(ev, drop);
    }
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "hidden" || !watchAcc) return;
        watchAcc.tick = 0;
        persistWatch(watchAcc, true);
        flushWatch();
      },
      { signal },
    );
    window.addEventListener("pagehide", () => persistWatch(watchAcc, true), { signal });
    addInterval(() => {
      flushWatch();
      flushPendingWatch();
    }, WATCH_SYNC_MS);
    flushPendingWatch();
    const HEAT_BUCKETS = 160;
    const HEAT_MIN_DURATION = 10;
    let heatLayer = null;
    let heatVideo = null;
    let heatRaf = 0;
    let heatUrl = null;
    let heatBroken = false;
    const heatEnabled = () => GM_getValue("lk:heatmap", "1") !== "0";
    function buildHeatLayer() {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "fixed",
        zIndex: "2147483000",
        pointerEvents: "none",
        display: "none",
        transition: "opacity .2s",
        font: "600 11px/1.4 system-ui, sans-serif",
      });
      const bar = document.createElement("div");
      bar.dataset.lk = "bar";
      bar.style.cssText =
        "position:absolute;left:0;right:0;bottom:0;height:5px;display:flex;" +
        "border-radius:3px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.35)";
      const pill = document.createElement("div");
      pill.dataset.lk = "pill";
      pill.style.cssText =
        "position:absolute;right:8px;bottom:12px;padding:3px 8px;border-radius:999px;" +
        "color:#fff;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);white-space:nowrap";
      const head = document.createElement("div");
      head.dataset.lk = "head";
      head.style.cssText =
        "position:absolute;bottom:0;width:2px;height:9px;background:#fff;" +
        "box-shadow:0 0 3px rgba(0,0,0,.9);border-radius:1px;transform:translateX(-1px);display:none";
      el.append(bar, head, pill);
      document.body.appendChild(el);
      return el;
    }
    function markersForCurrentVideo(video) {
      const url = normalizeUrl(location.href);
      if (url !== heatUrl) {
        heatUrl = url;
        videoSpeedMaps.set(
          video,
          new Map(
            Object.entries(loadLocalMarkers(url).markers).map(([t, s]) => [parseFloat(t), s]),
          ),
        );
      }
      return Object.fromEntries(videoSpeedMaps.get(video) ?? []);
    }
    function paintHeatmap(video) {
      try {
        paintHeatmapUnsafe(video);
      } catch (err) {
        console.error("[Lianki] Difficulty overlay disabled after error:", err);
        hideHeatmap();
        heatBroken = true;
      }
    }
    function paintHeatmapUnsafe(video) {
      if (heatBroken) return;
      if (!heatEnabled() || !video || !Number.isFinite(video.duration)) return hideHeatmap();
      if (video.duration < HEAT_MIN_DURATION) return hideHeatmap();
      const markers = markersForCurrentVideo(video);
      const { score, label, marked, segments } = videoDifficulty(markers, video.duration);
      heatLayer ??= buildHeatLayer();
      const bar = heatLayer.querySelector('[data-lk="bar"]');
      const pill = heatLayer.querySelector('[data-lk="pill"]');
      const buckets = heatmapBuckets(segments, video.duration, HEAT_BUCKETS);
      bar.replaceChildren();
      const acc = watchAccFor();
      const played = video.played;
      const seenAt = (t) => {
        const bit = Math.floor(t / COV_BUCKET_S);
        if (acc.cov.length && bit >> 3 < acc.cov.length && acc.cov[bit >> 3] & (1 << (bit & 7)))
          return true;
        for (let i = 0; i < played.length; i++)
          if (t >= played.start(i) && t <= played.end(i)) return true;
        return false;
      };
      const width = video.duration / buckets.length;
      buckets.forEach((rate, i) => {
        const cell = document.createElement("div");
        const mid = i * width + width / 2;
        const seen =
          seenAt(i * width) || seenAt(mid) || seenAt(Math.min(video.duration, (i + 1) * width));
        cell.style.cssText = `flex:1;background:${rateColor(rate, seen ? (marked > 0 ? 0.92 : 0.3) : 0.1)}`;
        bar.appendChild(cell);
      });
      if (marked > 0) {
        pill.textContent = `${score.toFixed(2)}× ${label} · ${Math.round(marked * 100)}% marked`;
        pill.style.color = rateColor(score);
        pill.style.opacity = "1";
      } else {
        pill.textContent = US.speedUnrated;
        pill.style.color = "#cbd5e1";
        pill.style.opacity = "0.75";
      }
      heatVideo = video;
      positionHeatmap();
    }
    function movePlayhead(video) {
      const head = heatLayer?.querySelector('[data-lk="head"]');
      if (!head || heatLayer.style.display === "none") return;
      const d = video.duration;
      if (!Number.isFinite(d) || d <= 0) return (head.style.display = "none");
      head.style.display = "block";
      head.style.left = `${Math.min(100, Math.max(0, (video.currentTime / d) * 100))}%`;
    }
    function positionHeatmap() {
      if (!heatLayer || !heatVideo) return;
      const r = heatVideo.getBoundingClientRect();
      const visible = r.width > 120 && r.height > 80 && r.bottom > 0 && r.top < innerHeight;
      heatLayer.style.display = visible ? "block" : "none";
      if (!visible) return;
      Object.assign(heatLayer.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    }
    function hideHeatmap() {
      if (heatLayer) heatLayer.style.display = "none";
    }
    const scheduleHeatReposition = () => {
      cancelAnimationFrame(heatRaf);
      heatRaf = requestAnimationFrame(positionHeatmap);
    };
    addEventListener("scroll", scheduleHeatReposition, { passive: true, capture: true, signal });
    addEventListener("resize", scheduleHeatReposition, { passive: true, signal });
    function setupHeatmap(video) {
      for (const ev of ["loadedmetadata", "ratechange", "durationchange"])
        video.addEventListener(ev, () => paintHeatmap(video));
      video.addEventListener("play", () => paintHeatmap(video));
      video.addEventListener("timeupdate", () => movePlayhead(video));
      if (Number.isFinite(video.duration) && video.duration > 0) paintHeatmap(video);
      setTimeout(() => paintHeatmap(video), 1500);
    }
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.code !== "KeyH" || !e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        GM_setValue("lk:heatmap", heatEnabled() ? "0" : "1");
        if (heatEnabled()) paintHeatmap(heatVideo ?? $$("video,audio")[0]);
        else hideHeatmap();
        centerTooltip(heatEnabled() ? US.heatOn : US.heatOff);
      },
      { capture: true, signal },
    );
    function observeVideos() {
      const tracked = new WeakSet();
      const trackVideo = (v) => {
        if (tracked.has(v)) return;
        tracked.add(v);
        setupVideoSpeedTracking(v);
        setupWatchTracking(v);
        setupHeatmap(v);
      };
      $$("video,audio").forEach(trackVideo);
      const observer = new MutationObserver(() => {
        $$("video,audio").forEach(trackVideo);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    observeVideos();
    addInterval(async () => {
      try {
        const url = normalizeUrl(location.href);
        const cache = loadLocalMarkers(url);
        if (!cache.dirty) return;
        const count = Object.keys(cache.markers).length;
        await api("/api/fsrs/speed-markers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, markers: cache.markers }),
        });
        saveLocalMarkers(url, cache.markers, false);
        console.log(`[Lianki] Synced ${count} speed markers → ${ORIGIN}/api/fsrs/speed-markers`, {
          url,
          markers: cache.markers,
        });
      } catch (err) {
        logFail("markers-sync", `speed-marker sync for ${normalizeUrl(location.href)}`, err);
      }
    }, 30000);
    let offlineReady = false;
    let cardStorage, configStorage, queueStorage, localFSRS;
    const deviceId = getOrCreateDeviceId();
    let syncInProgress = false;
    let syncTimer = null;
    function initOfflineStorage() {
      try {
        cardStorage = new GMCardStorage();
        configStorage = new GMConfigStorage();
        queueStorage = new GMQueueStorage();
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
      if (dialog) return;
      dialog = mountDialog();
      state = { phase: "adding", noteId: null, options: null, error: null, message: null };
      prefetchedNextUrl = null;
      renderDialog();
      dialog.focus();
      const url = normalizeUrl(location.href);
      if (offlineReady && cardStorage.isDeleted(url)) {
        state.phase = "deleted";
        state.message = US.youDeleted;
        renderDialog();
        return;
      }
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
          logFail("cache-check", "cache check", err);
        }
      }
      addNote(url, pageTitle())
        .then(async (note) => {
          state.noteId = note._id;
          state.notes = note.notes ?? "";
          state.notesSynced = true;
          if (offlineReady) {
            try {
              cardStorage.setCard(url, note, note.hlc ?? newHLC(deviceId, null));
            } catch (err) {
              console.error("[Lianki] Failed to cache card:", err);
            }
          }
          getNextUrl()
            .then((data) => {
              prefetchedNextUrl = data.url;
              if (data.url) prefetchNextPage(data.url);
            })
            .catch(() => {});
          if (note.options) {
            return { options: note.options };
          }
          if (offlineReady && localFSRS) {
            return { options: localFSRS.calculateOptions(note.card) };
          }
          return getOptions(note._id);
        })
        .then((data) => {
          state.phase = "reviewing";
          state.options = data.options;
          renderDialog();
        })
        .catch((err) => {
          if (
            offlineReady &&
            (err?.status === 401 ||
              String(err?.message).includes("401") ||
              String(err?.message).toLowerCase().includes("unauthorized"))
          ) {
            const localNote = {
              _id: "local:" + hashUrl(url),
              url,
              title: pageTitle(),
              card: localFSRS.newCard(),
              notes: "",
              hlc: newHLC(deviceId, null),
            };
            cardStorage.setCard(url, localNote, localNote.hlc, true);
            queueStorage.addToQueue("add", { url, title: pageTitle() }, localNote.hlc);
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
      if (state.phase !== "reviewing" || !state.noteId) return;
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
            queueStorage.addToQueue(
              "review",
              {
                url,
                noteId: state.noteId,
                rating,
              },
              newHlc,
            );
            try {
              const dueCards = cardStorage.getDueCards(2, location.origin, reviewOrder());
              const normalizedCurrent = normalizeUrl(location.href);
              const nextCard = dueCards.find((c) => c.url !== url && c.url !== normalizedCurrent);
              prefetchedNextUrl = nextCard?.url ?? null;
              if (prefetchedNextUrl) prefetchNextPage(prefetchedNextUrl);
            } catch (e) {
              prefetchedNextUrl = null;
            }
            const opt = state.options.find((o) => Number(o.rating) === rating);
            await afterReview(fillUs(US.reviewed, { due: opt?.due ?? "?" }));
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
        prefetchedNextUrl = result.nextUrl ?? null;
        if (result.nextUrl) prefetchNextPage(result.nextUrl);
        const opt = state.options.find((o) => Number(o.rating) === rating);
        await afterReview(fillUs(US.reviewed, { due: opt?.due ?? "?" }));
      } catch (err) {
        state.phase = "error";
        state.error = err.message;
        state.errorDetails = err.details ?? null;
        renderDialog();
      }
    };
    function startBackgroundSync() {
      syncTimer = addInterval(() => {
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
    function adoptServerVersion(item, body) {
      const url = item?.data?.url;
      if (!url || !body?.card) return;
      try {
        const existing = cardStorage.getEntry
          ? cardStorage.getEntry(url)
          : cardStorage.getCard(url);
        const note = { ...existing?.note, url, card: body.card, log: body.log ?? [] };
        cardStorage.setCard(url, note, body.serverHLC ?? existing?.hlc ?? null, false);
      } catch (e) {
        console.error("[Lianki] could not adopt server version for", url, e);
      }
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
        for (const item of queue) {
          try {
            await syncQueueItem(item);
            queueStorage.removeFromQueue(item.id);
            console.log(`[Lianki] Synced: ${item.action} ${item.data.url || item.data.noteId}`);
          } catch (err) {
            const status = err?.status;
            logFail("queue", `queued sync of ${item.id}`, err);
            const permanent = isPermanentSyncFailure(status);
            if (status === 409) {
              adoptServerVersion(item, err.body);
              queueStorage.removeFromQueue(item.id);
              console.warn(`[Lianki] ${item.id}: server had a newer version — adopted it`);
            } else if (permanent) {
              queueStorage.removeFromQueue(item.id);
              console.warn(
                `[Lianki] Dropping ${item.id}: HTTP ${status} will not succeed on retry`,
              );
            } else {
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
        }
        configStorage.updateLastSync(newHLC(deviceId, null));
        console.log("[Lianki] Sync complete");
      } finally {
        syncInProgress = false;
      }
    }
    async function syncQueueItem(item) {
      switch (item.action) {
        case "review": {
          const result = await api(
            `/api/fsrs/review/${item.data.rating}/?id=${encodeURIComponent(item.data.noteId)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ hlc: item.hlc }),
            },
          );
          if (item.data.url) {
            const cached = cardStorage.getCard(item.data.url);
            if (cached) {
              if (result?.card) cached.note.card = result.card;
              cardStorage.setCard(item.data.url, cached.note, result?.hlc ?? item.hlc, false);
            }
          }
          break;
        }
        case "add": {
          const addResult = await addNote(item.data.url, item.data.title);
          if (addResult && item.data.url) {
            const cached = cardStorage.getCard(item.data.url);
            if (cached) {
              if (addResult._id) cached.note._id = addResult._id;
              cardStorage.setCard(item.data.url, cached.note, addResult.hlc ?? item.hlc, false);
            }
          }
          break;
        }
        case "delete":
          await deleteNote(item.data.noteId, item.data.url);
          break;
        case "sync":
          await api(`/api/fsrs/get?url=${encodeURIComponent(item.data.url)}`);
          break;
      }
    }
    async function prefetchDueCards() {
      if (!offlineReady || !navigator.onLine) return;
      try {
        console.log("[Lianki] Prefetching due cards...");
        const LIMIT = 20;
        const response = await api(`/api/fsrs/due?limit=${LIMIT}`);
        const dueCards = response.cards || [];
        const live = new Set(dueCards.map((n) => n.url));
        const w = dueWindow(
          dueCards.map((n) => new Date(n.card?.due).getTime()),
          dueCards.length,
          LIMIT,
        );
        for (const stale of cardStorage.getDueCards(9999)) {
          if (live.has(stale.url) || stale.dirty) continue;
          if (!isProvablyDeleted(new Date(stale.note?.card?.due).getTime(), w)) continue;
          console.log(`[Lianki] Dropping locally cached card deleted on the server: ${stale.url}`);
          cardStorage.deleteCard(stale.url);
          if (prefetchedNextUrl === stale.url) prefetchedNextUrl = null;
        }
        for (const note of dueCards) {
          try {
            const url = note.url;
            const existing = cardStorage.getEntry(url);
            if (!existing || compareHLC(note.hlc, existing.hlc) > 0) {
              cardStorage.setCard(url, note, note.hlc || newHLC("server", null), false);
            }
          } catch (err) {
            console.error(`[Lianki] Failed to cache card ${note.url}:`, err);
          }
        }
        console.log(`[Lianki] Prefetched ${dueCards.length} cards`);
      } catch (err) {
        if (isAuthError(err))
          warnOnce(
            "auth:prefetch",
            "[Lianki] Not signed in — using locally cached cards only.",
            err.message,
          );
        else console.error("[Lianki] Prefetch failed:", err);
      }
    }
    async function prefetchNextCachedCard() {
      if (!offlineReady) return;
      try {
        const dueCards = cardStorage.getDueCards(2, location.origin, reviewOrder());
        const normalizedCurrent = normalizeUrl(location.href);
        const nextCard = dueCards.find((c) => c.url !== normalizedCurrent);
        if (nextCard) {
          prefetchNextPage(nextCard.url);
        }
      } catch (err) {
        logFail("prefetch-next", "next-card prefetch", err);
      }
    }
    setTimeout(() => {
      initOfflineStorage();
    }, 100);
    let stopPartner = () => {};
    if (location.hostname === "docs.google.com") {
      startGdocStream({ origin: ORIGIN, gmFetch, getValue: GM_getValue, setValue: GM_setValue });
    }
    startPartner({
      origin: ORIGIN,
      src:
        typeof __LK_PARTNER_SRC__ === "string" ? __LK_PARTNER_SRC__ : `${ORIGIN}/partner-embed.js`,
      gmFetch,
      getValue: GM_getValue,
      setValue: GM_setValue,
      deleteValue: GM_deleteValue,
      info: GM_info,
      report: (what, detail) =>
        what === "partner-mode" && detail.startsWith("isolated")
          ? console.debug(`[Lianki] ${what}: ${detail}`)
          : console.error(`[Lianki] ${what}: ${detail}`),
    })
      .then((stop) => {
        if (signal.aborted) stop();
        else stopPartner = stop;
      })
      .catch((err) => console.error("[Lianki] partner failed:", err));
    return () => {
      stopPartner();
      liChat.close();
      ac.abort();
      for (const id of intervals) clearInterval(id);
      intervals.length = 0;
      closeDialog();
      videoObserver?.disconnect();
      fab?.remove();
      fab = null;
    };
  }
})();
