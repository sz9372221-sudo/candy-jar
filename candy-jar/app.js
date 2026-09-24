(() => {
  "use strict";

  /* ========================================================
     Configuration and state
     ======================================================== */

  const STORE_KEY = "kindJars.v1";
  const CAPACITY = 50;
  const MESSAGE_LIMIT = 150;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const CANDY_COLORS = [
    "#FFD6E8",
    "#FFFDFB",
    "#FF9EC4",
    "#E8D9FF",
    "#FFE29A"
  ];

  const $ = id => document.getElementById(id);

  let activeCode = null;
  let routeVersion = 0;
  let addingCandy = false;
  let openingCandy = false;
  let cancelFlight = null;
  let closingDrawer = false;

  const closingDialogs = new WeakMap();
  const dialogAnimations = new WeakMap();
  const submittingForms = new WeakSet();

  /* ========================================================
     Storage
     ======================================================== */

  function readStore() {
    const raw = localStorage.getItem(STORE_KEY);
    const data = raw ? JSON.parse(raw) : {};

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid jar storage");
    }

    return data;
  }

  function writeStore(data) {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  }

  function getJar(data, code) {
    if (!Object.prototype.hasOwnProperty.call(data, code)) {
      return null;
    }

    const jar = data[code];

    return jar &&
      typeof jar === "object" &&
      typeof jar.name === "string"
      ? jar
      : null;
  }

  /*
   * Supports the earlier numeric candy-count format and the
   * current array format. Old preview candies can lack messages.
   */
  function getCandyRecords(jar) {
    if (Array.isArray(jar.candies)) {
      return jar.candies.slice(0, CAPACITY);
    }

    const numericCount = Number(jar.candies);
    const count = Number.isFinite(numericCount)
      ? Math.max(0, Math.min(CAPACITY, Math.floor(numericCount)))
      : 0;

    if (count === 0) return [];

    const messages = Array.isArray(jar.messages)
      ? jar.messages.slice(-count)
      : [];

    const offset = Math.max(0, count - messages.length);

    return Array.from({ length: count }, (_, index) => {
      const value = index >= offset
        ? messages[index - offset]
        : null;

      return {
        id: `legacy-${index}`,
        message: typeof value === "string"
          ? value
          : value?.message || "",
        createdAt: value?.createdAt || null
      };
    });
  }

  function makeJarCode(data) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      const code = Array.from(
        bytes,
        value => CODE_ALPHABET[value % CODE_ALPHABET.length]
      ).join("");

      if (!Object.prototype.hasOwnProperty.call(data, code)) {
        return code;
      }
    }

    throw new Error("Could not generate an available jar code");
  }

  function makeCandyId() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return Array.from(
      crypto.getRandomValues(new Uint8Array(12)),
      value => value.toString(16).padStart(2, "0")
    ).join("");
  }

  /* ========================================================
     General helpers and animation
     ======================================================== */

  function setStatus(message) {
    $("status").textContent = message;
  }

  function showError(id, message) {
    $(id).textContent = message;
    $(id).hidden = false;
  }

  function clearError(id) {
    $(id).textContent = "";
    $(id).hidden = true;
  }

  function reducedMotion() {
    return window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
  }

  function animateElement(element, frames, options = {}) {
    if (reducedMotion() || !element.animate) {
      return Promise.resolve();
    }

    const animation = element.animate(frames, {
      duration: 260,
      easing: "cubic-bezier(.22, 1, .36, 1)",
      ...options
    });

    return animation.finished.catch(() => {});
  }

  function animatePageEntrance() {
    void animateElement($("app"), [
      { opacity: 0 },
      { opacity: 1 }
    ], { duration: 250 });

    void animateElement($("jar-figure"), [
      {
        opacity: 0,
        transform: "translateY(14px) scale(.97)"
      },
      {
        opacity: 1,
        transform: "translateY(0) scale(1)"
      }
    ], { duration: 420 });

    if (activeCode) {
      void animateElement($("jar-heading"), [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" }
      ], { duration: 320 });
    }
  }

  function syncBodyModalState() {
    document.body.classList.toggle(
      "modal-open",
      Boolean(document.querySelector("dialog[open]"))
    );
  }

  function showDialog(dialog) {
    if (dialog.open) return;

    dialogAnimations.get(dialog)?.cancel();
    dialog.classList.remove("is-closing");
    dialog.showModal();
    syncBodyModalState();

    if (!reducedMotion() && dialog.animate) {
      const animation = dialog.animate([
        {
          opacity: 0,
          transform: "translateY(12px) scale(.96)"
        },
        {
          opacity: 1,
          transform: "translateY(0) scale(1)"
        }
      ], {
        duration: 240,
        easing: "cubic-bezier(.22, 1, .36, 1)"
      });

      dialogAnimations.set(dialog, animation);
      animation.finished.catch(() => {});
    }
  }

  function closeDialog(dialog, immediate = false) {
    if (immediate) {
      dialogAnimations.get(dialog)?.cancel();
      if (dialog.open) dialog.close();
      dialog.classList.remove("is-closing");
      syncBodyModalState();
      return Promise.resolve();
    }

    if (closingDialogs.has(dialog)) {
      return closingDialogs.get(dialog);
    }

    if (!dialog.open) return Promise.resolve();

    const task = (async () => {
      dialogAnimations.get(dialog)?.cancel();
      dialog.classList.add("is-closing");

      if (!reducedMotion() && dialog.animate) {
        const animation = dialog.animate([
          {
            opacity: 1,
            transform: "translateY(0) scale(1)"
          },
          {
            opacity: 0,
            transform: "translateY(7px) scale(.98)"
          }
        ], {
          duration: 150,
          easing: "ease-in"
        });

        dialogAnimations.set(dialog, animation);
        await animation.finished.catch(() => {});
      }

      if (dialog.open) dialog.close();
      dialog.classList.remove("is-closing");
      syncBodyModalState();
    })();

    closingDialogs.set(dialog, task);
    task.finally(() => closingDialogs.delete(dialog));

    return task;
  }

  /* ========================================================
     My Jars shelf drawer
     ======================================================== */

  function isDrawerOpen() {
    return $("jars-drawer").classList.contains("is-open");
  }

  function openJarsDrawer() {
    const drawer = $("jars-drawer");

    if (isDrawerOpen()) return;

    drawer.hidden = false;
    // Let the browser paint the hidden→visible state before
    // transitioning, so the slide-in animation plays.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        drawer.classList.add("is-open");
      });
    });

    document.body.classList.add("jars-open");

    if (!reducedMotion()) {
      $("jars-drawer-close").focus({ preventScroll: true });
    }
  }

  function closeJarsDrawer() {
    const drawer = $("jars-drawer");

    if (!isDrawerOpen()) {
      drawer.hidden = true;
      document.body.classList.remove("jars-open");
      return;
    }
    if (closingDrawer) return;

    closingDrawer = true;
    drawer.classList.remove("is-open");

    const finish = () => {
      drawer.hidden = true;
      document.body.classList.remove("jars-open");
      closingDrawer = false;
    };

    if (reducedMotion()) {
      finish();
      return;
    }

    setTimeout(finish, 320);
  }

  function openFormDialog(kind) {
    if (kind === "add" && addingCandy) return;

    const form = $(`${kind}-form`);
    if (submittingForms.has(form)) return;

    form.reset();
    clearError(`${kind}-error`);

    if (kind === "add") {
      $("message-count").textContent = `0 / ${MESSAGE_LIMIT}`;
    }

    showDialog($(`${kind}-dialog`));
  }

  function bindSubmit(formId, handler) {
    const form = $(formId);

    form.addEventListener("submit", async event => {
      event.preventDefault();

      if (submittingForms.has(form)) return;

      submittingForms.add(form);
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;

      try {
        await handler();
      } catch (error) {
        console.error("Form submission failed:", error);
        showError(
          formId.replace("-form", "-error"),
          "Oops! Something went wrong. Please try again 🍭"
        );
      } finally {
        submittingForms.delete(form);
        submit.disabled = false;
      }
    });
  }

  /* ========================================================
     Seeded randomness and SVG helpers
     ======================================================== */

  function hashString(text) {
    let hash = 2166136261;

    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
  }

  function seededRandom(seed) {
    let value = seed >>> 0;

    return () => {
      value = (value + 0x6D2B79F5) | 0;
      let mixed = Math.imul(value ^ (value >>> 15), 1 | value);

      mixed = (
        mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)
      ) ^ mixed;

      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  function svgElement(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);

    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }

    return element;
  }

  function mixColor(hex, targetHex, amount) {
    const source = parseInt(hex.slice(1), 16);
    const target = parseInt(targetHex.slice(1), 16);

    const channels = [16, 8, 0].map(shift => {
      const first = (source >> shift) & 255;
      const second = (target >> shift) & 255;

      return Math.round(
        first * (1 - amount) + second * amount
      ).toString(16).padStart(2, "0");
    });

    return `#${channels.join("")}`;
  }

  function addGloss(group, x = -4, y = -5) {
    group.append(svgElement("ellipse", {
      cx: x,
      cy: y,
      rx: 3,
      ry: 1.8,
      fill: "#FFFFFF",
      stroke: "none",
      opacity: .82,
      transform: `rotate(-25 ${x} ${y})`
    }));
  }

  /* ========================================================
     Six candy components
     ======================================================== */

  const HEART_PATH =
    "M0 11C-3 7-13 1-13-5" +
    "C-13-13-4-14 0-6" +
    "C4-14 13-13 13-5" +
    "C13 1 3 7 0 11Z";

  const STAR_POINTS =
    "0,-14 4,-5 14,-4 7,3 9,13 " +
    "0,8 -9,13 -7,3 -14,-4 -4,-5";

  function drawRound(color) {
    const group = svgElement("g");

    group.append(
      svgElement("circle", {
        cx: .8,
        cy: 1.2,
        r: 12,
        fill: mixColor(color, "#795D70", .2)
      }),
      svgElement("circle", {
        r: 12,
        fill: color,
        stroke: "#AC809D",
        "stroke-width": .6
      }),
      svgElement("circle", {
        cx: -3,
        cy: -3,
        r: 7,
        fill: "#FFFFFF",
        opacity: .22
      })
    );

    addGloss(group);
    return group;
  }

  function drawHeart(color) {
    const group = svgElement("g");

    group.append(
      svgElement("path", {
        d: HEART_PATH,
        fill: mixColor(color, "#795D70", .18),
        transform: "translate(.7 1.2)"
      }),
      svgElement("path", {
        d: HEART_PATH,
        fill: color,
        stroke: "#AC809D",
        "stroke-width": .6
      })
    );

    addGloss(group, -5, -6);
    return group;
  }

  function drawStar(color) {
    const group = svgElement("g");

    group.append(
      svgElement("polygon", {
        points: STAR_POINTS,
        fill: mixColor(color, "#795D70", .18),
        transform: "translate(.7 1.2)"
      }),
      svgElement("polygon", {
        points: STAR_POINTS,
        fill: color,
        stroke: "#AC809D",
        "stroke-width": .6,
        "stroke-linejoin": "round"
      })
    );

    addGloss(group, -2, -3);
    return group;
  }

  function drawStriped(color) {
    const group = drawRound(color);

    const stripes = svgElement("g", {
      "clip-path": "url(#candy-circle-clip)",
      transform: "rotate(-28)"
    });

    for (const x of [-8, 0, 8]) {
      stripes.append(svgElement("path", {
        d: `M${x} -14V14`,
        stroke: "#FFFFFF",
        "stroke-width": 3.8,
        opacity: .78
      }));
    }

    group.append(stripes);
    addGloss(group);
    return group;
  }

  function drawSwirl(color) {
    const group = drawRound(color);

    group.append(svgElement("path", {
      d: "M0-9A9 9 0 0 1 0 9A7 7 0 0 1 0-5A4 4 0 0 1 0 3",
      fill: "none",
      stroke: "#FFFFFF",
      "stroke-width": 3,
      "stroke-linecap": "round",
      opacity: .88
    }));

    addGloss(group, 4, -5);
    return group;
  }

  function drawWrapped(color) {
    const group = svgElement("g");
    const dark = mixColor(color, "#795D70", .16);

    group.append(
      svgElement("path", {
        d: "M-9-5L-21-10L-18 0L-21 10L-9 5Z",
        fill: dark,
        stroke: "#FFFFFF",
        "stroke-opacity": .5,
        "stroke-width": .8
      }),
      svgElement("path", {
        d: "M9-5L21-10L18 0L21 10L9 5Z",
        fill: dark,
        stroke: "#FFFFFF",
        "stroke-opacity": .5,
        "stroke-width": .8
      }),
      svgElement("rect", {
        x: -12,
        y: -10,
        width: 24,
        height: 20,
        rx: 8,
        fill: color,
        stroke: "#AC809D",
        "stroke-width": .6
      }),
      svgElement("path", {
        d: "M-5-8V8M2-8V8M8-6V6",
        fill: "none",
        stroke: "#FFFFFF",
        "stroke-width": 2.5,
        opacity: .5
      })
    );

    addGloss(group);
    return group;
  }

  const CANDY_VARIANTS = {
    round: drawRound,
    heart: drawHeart,
    star: drawStar,
    striped: drawStriped,
    swirl: drawSwirl,
    wrapped: drawWrapped
  };

  function createCandyArt(candy) {
    const art = CANDY_VARIANTS[candy.variant](candy.color);
    art.setAttribute("class", "candy-art");
    return art;
  }

  /* ========================================================
     Natural pile layout

     Candies sample resting positions and settle against the
     floor or candies below them, rather than using a grid.
     The seed keeps each jar's appearance repeatable.
     ======================================================== */

  function createPile(count, code) {
    const random = seededRandom(hashString(`${code}:pile-v3`));
    const variants = Object.keys(CANDY_VARIANTS);
    const pile = [];

    for (let index = 0; index < count; index++) {
      const variant = variants[
        Math.floor(random() * variants.length)
      ];

      const color = CANDY_COLORS[
        Math.floor(random() * CANDY_COLORS.length)
      ];

      const scale = .82 + random() * .14;
      const rotation = random() * 40 - 20;
      const radius = (variant === "wrapped" ? 20 : 14.5) * scale;

      let best = null;

      for (let sample = 0; sample < 80; sample++) {
        const x = 82 + radius + random() * (196 - radius * 2);

        // Lift the floor slightly near the rounded bottom corners.
        const floor = 372 -
          Math.max(0, Math.abs(x - 180) - 62) * .45;

        let y = floor - radius;

        for (const other of pile) {
          const separation = (radius + other.radius) * .94;
          const dx = Math.abs(x - other.x);

          if (dx < separation) {
            const contactY = other.y -
              Math.sqrt(separation ** 2 - dx ** 2);

            y = Math.min(y, contactY);
          }
        }

        const score = y - Math.abs(x - 180) * .035;

        if (!best || score > best.score) {
          best = { x, y, score };
        }
      }

      pile.push({
        index,
        x: best.x,
        y: best.y,
        radius,
        variant,
        color,
        rotation,
        scale
      });
    }

    // Keep unusually tall seeded piles below the jar shoulders.
    if (pile.length) {
      const top = Math.min(...pile.map(candy => candy.y - candy.radius));

      if (top < 183) {
        const compression = (372 - 183) / (372 - top);

        for (const candy of pile) {
          candy.y = 372 - (372 - candy.y) * compression;
        }
      }
    }

    return pile;
  }

  /* ========================================================
     Candy rendering and note opening
     ======================================================== */

  function renderCandies(records, code) {
    const layer = $("candy-layer");
    const pile = createPile(records.length, code);
    layer.replaceChildren();

    if (pile.length) {
      layer.append(svgElement("ellipse", {
        cx: 180,
        cy: 369,
        rx: Math.min(93, 22 + pile.length * 2),
        ry: 8,
        fill: "#795D91",
        opacity: .08,
        "aria-hidden": "true"
      }));
    }

    for (const candy of [...pile].sort((a, b) => a.y - b.y)) {
      const group = svgElement("g", {
        class: "candy-button",
        role: "button",
        tabindex: "0",
        "aria-label": `Unwrap candy ${candy.index + 1}`,
        "aria-haspopup": "dialog",
        "aria-controls": "note-dialog",
        transform:
          `translate(${candy.x} ${candy.y}) ` +
          `rotate(${candy.rotation}) scale(${candy.scale})`
      });

      const art = createCandyArt(candy);
      const hitRadius = candy.variant === "wrapped" ? 23 : 17;

      group.append(
        svgElement("circle", {
          r: hitRadius,
          fill: "transparent",
          "pointer-events": "all"
        }),
        svgElement("ellipse", {
          cx: 1,
          cy: 10,
          rx: 12,
          ry: 3,
          fill: "#795D91",
          opacity: .14,
          "aria-hidden": "true"
        }),
        art,
        svgElement("circle", {
          r: hitRadius + 1,
          class: "candy-focus-ring",
          "aria-hidden": "true"
        })
      );

      const open = () => {
        void openCandyNote(
          group,
          art,
          records[candy.index],
          code
        );
      };

      group.addEventListener("click", open);

      group.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });

      layer.append(group);
    }
  }

  async function openCandyNote(group, art, record, code) {
    if (openingCandy || addingCandy || code !== activeCode) return;

    openingCandy = true;
    const version = routeVersion;

    try {
      group.focus({ preventScroll: true });

      await animateElement(art, [
        { transform: "rotate(0) scale(1)" },
        { transform: "rotate(-9deg) scale(1.08)", offset: .32 },
        { transform: "rotate(7deg) scale(1.12)", offset: .65 },
        { transform: "rotate(0) scale(1)" }
      ], { duration: 310 });

      if (
        version !== routeVersion ||
        !group.isConnected ||
        code !== activeCode
      ) return;

      const message = typeof record === "string"
        ? record
        : record?.message;

      $("note-message").textContent =
        typeof message === "string" && message.trim()
          ? message
          : "This little candy doesn't have a saved note yet ♡";

      showDialog($("note-dialog"));
    } finally {
      openingCandy = false;
    }
  }

  /* ========================================================
     Falling candy animation
     ======================================================== */

  function animateCandyFall(candy, code, version) {
    const svg = $("jar-svg");
    const layer = $("candy-layer");
    const interior = $("jar-interior");

    const flight = svgElement("g", {
      class: "candy-incoming",
      "aria-hidden": "true"
    });

    const spinner = svgElement("g");
    const size = svgElement("g", {
      transform: `scale(${candy.scale})`
    });

    size.append(createCandyArt(candy));
    spinner.append(size);
    flight.append(spinner);

    // Initially outside the interior clip, behind the lid.
    svg.insertBefore(flight, interior);

    return new Promise(resolve => {
      let frameId = null;
      let startTime = null;
      let inside = false;
      let finished = false;

      const calm = reducedMotion();
      const duration = calm ? 140 : 1120;
      const matrix = svg.getScreenCTM();

      let startY = -60;

      if (matrix) {
        const point = svg.createSVGPoint();
        point.x = matrix.e + matrix.a * 180;
        point.y = -45;

        try {
          startY = point.matrixTransform(matrix.inverse()).y;
        } catch {
          startY = -60;
        }
      }

      function finish(success) {
        if (finished) return;
        finished = true;

        cancelAnimationFrame(frameId);
        flight.remove();

        if (cancelFlight === cancel) {
          cancelFlight = null;
        }

        resolve(success);
      }

      function cancel() {
        finish(false);
      }

      cancelFlight = cancel;

      function tick(now) {
        if (
          version !== routeVersion ||
          activeCode !== code ||
          !flight.isConnected
        ) {
          finish(false);
          return;
        }

        if (startTime === null) startTime = now;

        const progress = Math.min(
          1,
          (now - startTime) / duration
        );

        let x;
        let y;
        let rotation;

        if (calm) {
          x = candy.x;
          y = candy.y;
          rotation = candy.rotation;
          flight.style.opacity = String(progress);
        } else if (progress < .77) {
          const fall = progress / .77;
          const gravity = fall * fall;
          const drift = fall * fall * (3 - 2 * fall);

          x = 180 + (candy.x - 180) * drift;
          y = startY + (candy.y - startY) * gravity;
          rotation = -18 + (candy.rotation + 18) * fall;
        } else {
          const settle = (progress - .77) / .23;

          x = candy.x;
          y = candy.y -
            Math.sin(settle * Math.PI) * 9 * (1 - settle);
          rotation = candy.rotation +
            Math.sin(settle * Math.PI * 2) * 5 * (1 - settle);
        }

        if (!inside && y >= 177) {
          layer.append(flight);
          inside = true;
        }

        flight.setAttribute(
          "transform",
          `translate(${x} ${y})`
        );

        spinner.setAttribute(
          "transform",
          `rotate(${rotation})`
        );

        if (progress >= 1) {
          finish(true);
        } else {
          frameId = requestAnimationFrame(tick);
        }
      }

      frameId = requestAnimationFrame(tick);
    });
  }

  /* ========================================================
     Page rendering and routing
     ======================================================== */

  function updateAddButton(count) {
    const full = count >= CAPACITY;
    const button = $("add-button");

    button.disabled = full || addingCandy;
    button.textContent = full
      ? "🍬 Jar Full"
      : addingCandy
        ? "🍬 A little sweetness…"
        : "🍬 Add a Candy";
  }

  function renderPage(jar, code) {
    activeCode = jar ? code : null;

    const home = !jar;
    const records = jar ? getCandyRecords(jar) : [];
    const full = !home && records.length >= CAPACITY;

    $("app").classList.toggle("is-home", home);
    $("home-actions").hidden = !home;

    // The jar shelf is reachable from the home page for now.
    $("jars-fab-button").hidden = !home;

    for (const id of [
      "back-button",
      "jar-heading",
      "count-card",
      "code-card",
      "add-button"
    ]) {
      $(id).hidden = home;
    }

    $("jar-title").textContent = jar?.name || "My Jar";
    $("jar-code").textContent = code || "";
    $("candy-count").textContent = records.length;

    $("candy-hint").textContent = records.length === 0
      ? "A little empty, a lot of possibility ✨"
      : full
        ? "Fifty little kindnesses, all tucked inside 💖"
        : "Tap a candy to discover a little kindness 💌";

    $("full-card").hidden = !full;
    $("jar-figure").classList.toggle("is-full", full);

    $("jar-svg-title").textContent =
      `A glass jar containing ${records.length} of 50 candies`;

    document.title = jar
      ? `${jar.name} — Candy Jar of Kind Words`
      : "Candy Jar of Kind Words";

    updateAddButton(records.length);
    renderCandies(records, code || "home");
  }

  function currentRouteCode() {
    const match = location.hash.match(
      /^#\/jar\/([A-Za-z0-9]{6})$/
    );

    return match ? match[1].toUpperCase() : null;
  }

  function renderRoute() {
    routeVersion++;
    cancelFlight?.();

    document.querySelectorAll("dialog[open]").forEach(dialog => {
      void closeDialog(dialog, true);
    });

    closeJarsDrawer();

    setStatus("");

    const code = currentRouteCode();

    if (!code) {
      renderPage(null, null);
      animatePageEntrance();
      return;
    }

    try {
      const jar = getJar(readStore(), code);

      if (!jar) {
        renderPage(null, null);
        setStatus("Oops! We couldn't find that jar 🍭");
      } else {
        renderPage(jar, code);
        $("jar-title").focus({ preventScroll: true });
      }
    } catch (error) {
      console.error("Could not read jars:", error);
      renderPage(null, null);
      setStatus(
        "We couldn't read your saved jars. Please check browser storage."
      );
    }

    animatePageEntrance();
  }

  function navigate(code = null) {
    const hash = code ? `#/jar/${code}` : "#/";

    if (location.hash === hash) {
      renderRoute();
    } else {
      location.hash = hash;
    }
  }

  /* ========================================================
     Create, join, add and copy
     ======================================================== */

  async function createJar() {
    clearError("create-error");

    const name = $("jar-name-input").value.trim();

    if (!name) {
      showError(
        "create-error",
        "Give your jar a little name first 🎀"
      );
      $("jar-name-input").focus();
      return;
    }

    let code;
    const version = routeVersion;

    try {
      const data = readStore();
      code = makeJarCode(data);

      data[code] = {
        name: name.slice(0, 24),
        candies: [],
        capacity: CAPACITY,
        createdAt: Date.now()
      };

      writeStore(data);
    } catch (error) {
      console.error("Could not create jar:", error);
      showError(
        "create-error",
        "We couldn't save your jar. Please allow browser storage and try again."
      );
      return;
    }

    await closeDialog($("create-dialog"));

    if (version === routeVersion) {
      navigate(code);
    }
  }

  async function joinJar() {
    clearError("join-error");

    const code = $("join-code-input").value.trim().toUpperCase();
    const version = routeVersion;

    try {
      if (!getJar(readStore(), code)) {
        showError(
          "join-error",
          "Oops! We couldn't find that jar 🍭"
        );
        $("join-code-input").focus();
        $("join-code-input").select();
        return;
      }
    } catch (error) {
      console.error("Could not join jar:", error);
      showError(
        "join-error",
        "We couldn't read your jars. Please check browser storage."
      );
      return;
    }

    await closeDialog($("join-dialog"));

    if (version === routeVersion) {
      navigate(code);
    }
  }

  async function addCandy() {
    clearError("add-error");

    if (addingCandy || !activeCode) return;

    const message = $("message-input").value.trim();

    if (!message || message.length > MESSAGE_LIMIT) {
      showError(
        "add-error",
        "Write a little kindness, up to 150 characters 💗"
      );
      $("message-input").focus();
      return;
    }

    const code = activeCode;
    const version = routeVersion;
    let initialJar;
    let initialRecords;

    try {
      initialJar = getJar(readStore(), code);

      if (!initialJar) {
        showError(
          "add-error",
          "Oops! This jar is no longer available 🍭"
        );
        return;
      }

      initialRecords = getCandyRecords(initialJar);

      if (initialRecords.length >= CAPACITY) {
        showError(
          "add-error",
          "This jar is already full of kindness 💖"
        );
        updateAddButton(CAPACITY);
        return;
      }
    } catch (error) {
      console.error("Could not read jar:", error);
      showError(
        "add-error",
        "We couldn't read this jar. Your message is still here."
      );
      return;
    }

    addingCandy = true;
    updateAddButton(initialRecords.length);

    try {
      await closeDialog($("add-dialog"));

      if (version !== routeVersion || activeCode !== code) {
        return;
      }

      setStatus("A little kindness is on its way…");

      // Match the visible pile to the latest stored contents.
      renderPage(initialJar, code);

      const pile = createPile(initialRecords.length + 1, code);
      const newCandy = pile[pile.length - 1];

      const landed = await animateCandyFall(
        newCandy,
        code,
        version
      );

      if (!landed || version !== routeVersion) return;

      // Re-read after landing to avoid using an old snapshot.
      const data = readStore();
      const jar = getJar(data, code);

      if (!jar) {
        throw new Error("Jar no longer exists");
      }

      const records = getCandyRecords(jar);

      if (records.length >= CAPACITY) {
        renderPage(jar, code);
        setStatus("This jar just filled up with kindness 💖");
        return;
      }

      records.push({
        id: makeCandyId(),
        message,
        createdAt: Date.now()
      });

      jar.candies = records;
      jar.capacity = CAPACITY;

      // Persist before confirming the new count.
      writeStore(data);

      renderPage(jar, code);

      void animateElement($("candy-count"), [
        { opacity: .4, transform: "translateY(3px)" },
        { opacity: 1, transform: "translateY(0)" }
      ], { duration: 220 });

      if (records.length === CAPACITY) {
        setStatus("🍬 This jar is full!");

        void animateElement($("full-card"), [
          { opacity: 0, transform: "translateY(8px) scale(.98)" },
          { opacity: 1, transform: "translateY(0) scale(1)" }
        ], { duration: 320 });
      } else {
        setStatus(
          "Your kind words are saved inside the jar 💗"
        );
      }

      $("add-form").reset();
      $("message-count").textContent = `0 / ${MESSAGE_LIMIT}`;

      // The full state disables the previous focus target.
      if (records.length === CAPACITY) {
        $("create-another-button").focus({ preventScroll: true });
      }
    } catch (error) {
      console.error("Could not save candy:", error);

      if (version === routeVersion && activeCode === code) {
        setStatus(
          "Oops! We couldn't save that candy. Your message is still in the form."
        );

        showError(
          "add-error",
          "We couldn't save that candy. Please try again 🍭"
        );

        // Keep the text available rather than discarding it.
        showDialog($("add-dialog"));
      }
    } finally {
      addingCandy = false;

      if (activeCode) {
        const count = Number($("candy-count").textContent) || 0;
        updateAddButton(count);
      }
    }
  }

  async function copyCode() {
    const code = $("jar-code").textContent;
    const version = routeVersion;

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }

      await navigator.clipboard.writeText(code);

      if (version === routeVersion) {
        setStatus("Jar code copied 💗");
      }
    } catch {
      if (version !== routeVersion) return;

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($("jar-code"));

      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }

      setStatus("Select and copy the highlighted jar code.");
    }
  }

  /* ========================================================
     Events
     ======================================================== */

  $("create-button").addEventListener("click", () => {
    openFormDialog("create");
  });

  $("create-another-button").addEventListener("click", () => {
    openFormDialog("create");
  });

  $("join-button").addEventListener("click", () => {
    openFormDialog("join");
  });

  $("add-button").addEventListener("click", () => {
    openFormDialog("add");
  });

  $("back-button").addEventListener("click", () => {
    navigate();
  });

  $("jars-fab-button").addEventListener("click", () => {
    openJarsDrawer();
  });

  document.querySelectorAll("[data-close-jars]").forEach(element => {
    element.addEventListener("click", closeJarsDrawer);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && isDrawerOpen()) {
      closeJarsDrawer();
    }
  });

  $("copy-button").addEventListener("click", () => {
    void copyCode();
  });

  document.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", () => {
      void closeDialog(button.closest("dialog"));
    });
  });

  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      void closeDialog(dialog);
    });

    dialog.addEventListener("close", syncBodyModalState);

    // Backdrop clicks close the dialog; clicks inside do not.
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;

      const rect = dialog.getBoundingClientRect();
      const outside =
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom;

      if (outside) {
        void closeDialog(dialog);
      }
    });
  });

  $("jar-name-input").addEventListener("input", () => {
    clearError("create-error");
  });

  $("join-code-input").addEventListener("input", () => {
    const input = $("join-code-input");
    input.value = input.value.toUpperCase().replace(/\s/g, "");
    clearError("join-error");
  });

  $("message-input").addEventListener("input", () => {
    $("message-count").textContent =
      `${$("message-input").value.length} / ${MESSAGE_LIMIT}`;

    clearError("add-error");
  });

  bindSubmit("create-form", createJar);
  bindSubmit("join-form", joinJar);
  bindSubmit("add-form", addCandy);

  window.addEventListener("hashchange", renderRoute);

  // Refresh visible contents after changes from another same-origin tab.
  // localStorage is not a transactional multi-user backend.
  window.addEventListener("storage", event => {
    if (
      event.key !== STORE_KEY ||
      !activeCode ||
      addingCandy ||
      openingCandy ||
      document.querySelector("dialog[open]")
    ) return;

    try {
      const jar = getJar(readStore(), activeCode);

      if (jar) {
        renderPage(jar, activeCode);
        setStatus("Your jar was updated in another tab.");
      }
    } catch (error) {
      console.error("Could not refresh jar:", error);
    }
  });

  renderRoute();
})();
