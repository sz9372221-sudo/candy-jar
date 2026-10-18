(() => {
  "use strict";

  /* ========================================================
     Configuration and state
     ======================================================== */

  const STORE_KEY = "kindJars.v1";
  const LEGACY_OWNER_TOKEN_KEY = "kindJars.ownerToken.v1";
  const IDENTITY_KEY = "kindJars.identity.v1";
  const CAPACITY = 50;
  const MESSAGE_LIMIT = 150;
  const NAME_LIMIT = 24;
  const NAME_INPUT_LIMIT = 32;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const CANDY_COLORS = [
    "#FFD6E8",
    "#FFFDFB",
    "#FF9EC4",
    "#E8D9FF",
    "#FFE29A"
  ];

  const JAR_CARD_THEMES = [
    { accent: "#FF9EC4", wash: "#FFF0F6", shelf: "#FFD6E8" },
    { accent: "#F3C95E", wash: "#FFF9DC", shelf: "#FFEEC2" },
    { accent: "#89CDB3", wash: "#ECFAF4", shelf: "#CFEFE2" },
    { accent: "#BC846B", wash: "#F8EEE9", shelf: "#E8CFC1" },
    { accent: "#91AEE8", wash: "#EFF5FF", shelf: "#D7E4FA" }
  ];

  // One candy carries one kind of content. Only "text" is wired up
  // for now; the others are placeholders until uploads are supported.
  const CANDY_TYPES = ["text", "photo", "song"];
  const LIVE_CANDY_TYPES = ["text"];

  const $ = id => document.getElementById(id);

  let activeCode = null;
  let routeVersion = 0;
  let addingCandy = false;
  let openingCandy = false;
  let cancelFlight = null;
  let closingDrawer = false;
  let currentNote = null;
  let magicWelcomeStatus = null;

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

  /*
   * Ownership is the visitor's permanent identity token — the one
   * created with the welcome hello — not a separate random key.
   * Jars and candies remember that token.
   */
  function getOwnershipToken() {
    return getOrCreateIdentity().token;
  }

  function isJarOwner(jar) {
    const identityToken = getIdentity()?.token;

    return Boolean(
      jar && identityToken && jar.ownerToken === identityToken
    );
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
     Permanent identity for this visitor
     ======================================================== */

  function getIdentity() {
    try {
      const identity = JSON.parse(localStorage.getItem(IDENTITY_KEY));

      return identity &&
        typeof identity === "object" &&
        typeof identity.username === "string" &&
        typeof identity.token === "string"
        ? identity
        : null;
    } catch (error) {
      console.error("Could not read identity:", error);
      return null;
    }
  }

  function saveIdentity(identity) {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  }

  function makeIdentityToken() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replaceAll("-", "");
    }

    return Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      value => value.toString(16).padStart(2, "0")
    ).join("");
  }

  function makeUsername(name) {
    const suffix = crypto.getRandomValues(new Uint16Array(1))[0] % 10000;
    return `${name}_${String(suffix).padStart(4, "0")}`;
  }

  /*
   * A visitor who skipped the welcome hello (or whose identity has
   * only a placeholder name) still owns their jars, so a fallback
   * identity is created on first use. The welcome flow later adopts
   * the chosen name without ever changing the token.
   */
  function getOrCreateIdentity() {
    let identity = getIdentity();

    if (!identity) {
      identity = {
        name: "Friend",
        username: makeUsername("Friend"),
        token: makeIdentityToken(),
        createdAt: Date.now(),
        isPlaceholder: true
      };

      saveIdentity(identity);
    }

    return identity;
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

  function createMiniJarIcon(jar) {
    const svg = svgElement("svg", {
      class: "mini-jar-icon",
      viewBox: "0 0 90 100",
      xmlns: SVG_NS,
      role: "img",
      "aria-label": `Cute candy jar for ${jar.name}`
    });

    const title = svgElement("title");
    title.textContent = `${jar.name} candy jar`;
    svg.append(title);

    const bodyPath =
      "M28 29H62V35C62 40 73 43 73 53V81Q73 90 64 90H26Q17 90 17 81V53C17 43 28 40 28 35Z";

    svg.append(
      svgElement("path", {
        d: bodyPath,
        fill: jar.wash,
        stroke: "#C994AD",
        "stroke-width": 2
      }),
      svgElement("path", {
        d: bodyPath,
        fill: jar.accent,
        stroke: "#C994AD",
        "stroke-width": 2,
        opacity: .48
      }),
      svgElement("path", {
        d: "M25 44Q20 49 20 57V75",
        fill: "none",
        stroke: "#FFFFFF",
        "stroke-width": 4,
        "stroke-linecap": "round",
        opacity: .86
      }),
      svgElement("path", {
        d: "M45 55C38 49 29 57 45 72C61 57 52 49 45 55Z",
        fill: "#FFFFFF",
        opacity: .88
      }),
      svgElement("rect", {
        x: 25,
        y: 22,
        width: 40,
        height: 12,
        rx: 5,
        fill: jar.accent,
        stroke: "#C994AD",
        "stroke-width": 1.5
      }),
      svgElement("rect", {
        x: 29,
        y: 17,
        width: 32,
        height: 7,
        rx: 3.5,
        fill: "#FFFDFB",
        stroke: "#C994AD",
        "stroke-width": 1.5
      }),
      svgElement("path", {
        d: "M43 17C38 8 28 10 31 16C33 20 39 19 43 17ZM47 17C52 8 62 10 59 16C57 20 51 19 47 17Z",
        fill: jar.accent,
        stroke: "#C994AD",
        "stroke-width": 1.3
      }),
      svgElement("circle", {
        cx: 45,
        cy: 16,
        r: 3.5,
        fill: jar.wash,
        stroke: "#C994AD",
        "stroke-width": 1.2
      })
    );

    return svg;
  }

  function getShelfJars() {
    try {
      const data = readStore();

      return Object.keys(data).reduce((jars, code) => {
        const jar = getJar(data, code);

        if (jar) jars.push({ code, ...jar });
        return jars;
      }, []);
    } catch (error) {
      console.error("Could not read jars for the shelf:", error);
      return [];
    }
  }

  function getJarCardTheme(code) {
    return JAR_CARD_THEMES[hashString(code) % JAR_CARD_THEMES.length];
  }

  function renderJarsShelf() {
    const content = $("jars-drawer-content");
    const jars = getShelfJars();
    const intro = document.createElement("p");

    content.replaceChildren();
    intro.className = "shelf-intro";
    intro.textContent = jars.length
      ? "Every jar you make or open, all in one sweet little shelf."
      : "Your shelf is ready for something lovely.";

    content.append(intro);

    if (!jars.length) {
      const emptyState = document.createElement("div");
      const illustration = document.createElement("div");
      const message = document.createElement("p");

      emptyState.className = "jars-empty-state";
      illustration.className = "jars-empty-illustration";
      illustration.setAttribute("aria-hidden", "true");
      illustration.textContent = "🍭";
      message.textContent = "No jars yet! Create your first one 🍭";
      emptyState.append(illustration, message);
      content.append(emptyState);
      return;
    }

    const shelf = document.createElement("div");
    shelf.className = "jar-shelf";

    jars.forEach(({ code, ...jar }, index) => {
      const theme = getJarCardTheme(code);
      const card = document.createElement("button");
      const icon = document.createElement("div");
      const name = document.createElement("span");
      const count = document.createElement("span");
      const role = document.createElement("span");
      const records = getCandyRecords(jar);
      const isOwner = isJarOwner(jar);

      card.type = "button";
      card.className = "jar-shelf-card";
      card.style.setProperty("--jar-accent", theme.accent);
      card.style.setProperty("--jar-wash", theme.wash);
      card.style.setProperty("--shelf-color", theme.shelf);
      card.style.setProperty("--card-delay", `${index * 45}ms`);
      card.setAttribute(
        "aria-label",
        `Open ${jar.name}, ${records.length} of ${CAPACITY} candies, ${
          isOwner ? "you are the owner" : "you have joined"
        }`
      );

      icon.className = "jar-card-icon";
      icon.append(createMiniJarIcon({ ...jar, ...theme }));

      name.className = "jar-card-name";
      name.textContent = jar.name;

      count.className = "jar-card-count";
      count.textContent = `${records.length}/${CAPACITY} 🍬`;

      role.className = isOwner
        ? "jar-card-role is-owner"
        : "jar-card-role is-joined";
      role.textContent = isOwner ? "Owner 👑" : "Joined 🍬";

      card.addEventListener("click", () => {
        closeJarsDrawer(true);
        navigate(code);
      });

      card.append(icon, name, count, role);
      shelf.append(card);
    });

    content.append(shelf);
  }

  function isDrawerOpen() {
    return $("jars-drawer").classList.contains("is-open");
  }

  function openJarsDrawer() {
    const drawer = $("jars-drawer");

    if (isDrawerOpen()) return;

    renderJarsShelf();
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

  function closeJarsDrawer(immediate = false) {
    const drawer = $("jars-drawer");

    if (!isDrawerOpen()) {
      drawer.hidden = true;
      document.body.classList.remove("jars-open");
      return;
    }
    if (closingDrawer && !immediate) return;

    closingDrawer = true;
    drawer.classList.remove("is-open");

    const finish = () => {
      drawer.hidden = true;
      document.body.classList.remove("jars-open");
      closingDrawer = false;
    };

    if (immediate || reducedMotion()) {
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

      // A reset also clears the type radios, so resync the panels.
      setCandyType("text");
    }

    showDialog($(`${kind}-dialog`));
  }

  function setCandyType(type) {
    const chosen = CANDY_TYPES.includes(type) ? type : "text";
    const radio = $(`candy-type-${chosen}`);

    if (radio) radio.checked = true;

    CANDY_TYPES.forEach(value => {
      const panel = document.querySelector(
        `[data-candy-panel="${value}"]`
      );

      if (panel) panel.hidden = value !== chosen;
    });

    // Kinds that are not live yet keep the submit out of reach.
    $("add-submit").disabled = !LIVE_CANDY_TYPES.includes(chosen);

    clearError("add-error");
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
     First-visit welcome
     ======================================================== */

  const WELCOME_GREETING_MS = 2600;

  function showWelcomeModal() {
    const form = $("welcome-form");

    form.reset();
    clearError("welcome-error");
    form.hidden = false;
    $("welcome-success").hidden = true;

    showDialog($("welcome-dialog"));
  }

  async function submitWelcome() {
    clearError("welcome-error");

    const name = $("welcome-name-input").value.replace(/\s+/g, " ").trim();

    if (!name) {
      showError("welcome-error", "A little name helps us greet you ♡");
      return;
    }

    const existingIdentity = getIdentity();

    // The identity is permanent, so the token is written exactly
    // once; a later hello can only fill in the chosen name.
    if (!existingIdentity) {
      saveIdentity({
        name: name.slice(0, NAME_INPUT_LIMIT),
        username: makeUsername(name),
        token: makeIdentityToken(),
        createdAt: Date.now()
      });
    } else if (existingIdentity.isPlaceholder) {
      saveIdentity({
        name: name.slice(0, NAME_INPUT_LIMIT),
        username: makeUsername(name),
        token: existingIdentity.token,
        createdAt: existingIdentity.createdAt,
        isPlaceholder: false
      });
    }

    const identity = getIdentity();

    renderProfileBadge();

    // A returning visitor may own jars created before the identity
    // system; once the identity exists, their ownership carries over.
    migrateLegacyOwnerTokens();

    $("welcome-greeting").textContent =
      `Nice to meet you, ${identity.username}! 🍬`;
    $("welcome-form").hidden = true;
    $("welcome-success").hidden = false;

    if (!reducedMotion()) {
      $("welcome-greeting").classList.add("is-wiggling");
    }

    // Let the sweet little hello linger before letting them in.
    await new Promise(resolve => setTimeout(resolve, WELCOME_GREETING_MS));

    $("welcome-greeting").classList.remove("is-wiggling");
    await closeDialog($("welcome-dialog"));
  }

  /* ========================================================
     Visitor profile

     The sweet badge in the corner shows the identity's
     username. Changing the name mints a fresh username but
     keeps the same identity token, so jars and candies stay
     linked to this visitor.
     ======================================================== */

  function renderProfileBadge() {
    const identity = getIdentity();
    const badge = $("profile-badge");

    if (!identity) {
      badge.hidden = true;
      return;
    }

    $("profile-badge-name").textContent = identity.username;
    badge.hidden = false;
    badge.setAttribute("aria-label", `Your profile — ${identity.username}`);
  }

  function showProfileView() {
    $("profile-username").textContent = getIdentity()?.username || "";
    $("name-form").hidden = true;
    $("profile-view").hidden = false;
    clearError("name-error");
  }

  function openProfileDialog() {
    if (!getIdentity()) return;

    showProfileView();
    showDialog($("profile-dialog"));
  }

  function setProfileNameCount() {
    $("profile-name-count").textContent =
      `${$("name-input").value.length} / ${NAME_INPUT_LIMIT}`;
  }

  function enterNameEditMode() {
    const identity = getIdentity();

    if (!identity) return;

    const input = $("name-input");

    input.value = typeof identity.name === "string"
      ? identity.name.slice(0, NAME_INPUT_LIMIT)
      : "";

    setProfileNameCount();
    clearError("name-error");

    $("profile-view").hidden = true;
    $("name-form").hidden = false;

    input.focus({ preventScroll: true });

    // Ready to retype the whole name straight away.
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function cancelNameEdit() {
    showProfileView();
    $("change-name-button").focus({ preventScroll: true });
  }

  async function saveNameChange() {
    clearError("name-error");

    const name = $("name-input").value.replace(/\s+/g, " ").trim();

    if (!name) {
      showError("name-error", "A little name helps us greet you ♡");
      $("name-input").focus();
      return;
    }

    const identity = getOrCreateIdentity();

    const updated = {
      name: name.slice(0, NAME_INPUT_LIMIT),
      username: makeUsername(name),
      token: identity.token,
      createdAt: identity.createdAt,
      isPlaceholder: false
    };

    saveIdentity(updated);
    renderProfileBadge();
    showProfileView();

    void animateElement($("profile-username"), [
      { opacity: .35, transform: "translateY(4px) scale(.97)" },
      { opacity: 1, transform: "translateY(0) scale(1)" }
    ], { duration: 240 });

    setStatus(`Your sweet new name is ready, ${updated.username} ✨`);
  }

  /* ========================================================
     Magic link

     A shareable link that carries the identity token, so opening
     it in any browser adopts (or restores) this visitor's sweet
     name in one hop.
     ======================================================== */

  const MAGIC_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;
  const MAGIC_COPY_RESET_MS = 1800;
  const MAGIC_RESTORE_DELAY_MS = 600;
  const COPY_SPARKLE_GLYPHS = ["✨", "💖", "✦", "💕", "✧"];

  let pendingMagicRestore = null;
  let magicCopyResetTimer = null;

  function buildMagicLink(identity) {
    const params = new URLSearchParams({
      magic: identity.token,
      name: identity.username
    });

    return `${location.origin}${location.pathname}?${params}#/`;
  }

  function resetMagicCopyButton() {
    clearTimeout(magicCopyResetTimer);
    magicCopyResetTimer = null;

    const button = $("magic-copy-button");
    button.classList.remove("is-copied");
    button.textContent = "📋 Copy Link";
  }

  function burstCopySparkles(button) {
    if (reducedMotion()) return;

    for (let index = 0; index < 9; index++) {
      const spark = document.createElement("span");

      spark.className = "copy-sparkle";
      spark.setAttribute("aria-hidden", "true");
      spark.textContent = COPY_SPARKLE_GLYPHS[
        index % COPY_SPARKLE_GLYPHS.length
      ];

      const straightUp = index < 3;
      spark.style.setProperty(
        "--spark-dx",
        `${straightUp
          ? Math.random() * 26 - 13
          : Math.random() * 170 - 85}px`
      );
      spark.style.setProperty(
        "--spark-dy",
        `${-(52 + Math.random() * 58)}px`
      );
      spark.style.left = `${12 + Math.random() * 76}%`;
      spark.style.animationDelay = `${index * 55}ms`;

      spark.addEventListener(
        "animationend",
        () => spark.remove(),
        { once: true }
      );

      button.append(spark);
    }
  }

  async function copyMagicLink() {
    resetMagicCopyButton();

    const input = $("magic-link-input");
    const button = $("magic-copy-button");
    let copied = false;

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }

      await navigator.clipboard.writeText(input.value);
      copied = true;
    } catch {
      // Fallback: select the link so it can be copied by hand.
      input.focus({ preventScroll: true });
      input.select();

      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
    }

    if (!copied) {
      setStatus("Select the highlighted link and copy it by hand 🍭");
      return;
    }

    button.classList.add("is-copied");
    button.textContent = "✨ Copied! 💖";
    burstCopySparkles(button);

    magicCopyResetTimer = setTimeout(
      resetMagicCopyButton,
      MAGIC_COPY_RESET_MS
    );

    setStatus("Magic link copied! Keep it somewhere special 💗");
  }

  function openMagicLinkDialog() {
    const identity = getIdentity();

    if (!identity) return;

    $("magic-link-input").value = buildMagicLink(identity);
    resetMagicCopyButton();
    showDialog($("magic-link-dialog"));
  }

  /*
   * A magic link carries `?magic=<token>&name=<username>`. Opening
   * one adopts the name and token it carries, so jars owned by that
   * identity become this visitor's again. An existing, different
   * identity always gets a friendly confirmation first — it never
   * switches silently.
   */
  function clearMagicUrl() {
    const url = new URL(location.href);

    if (!url.search) return;

    url.search = "";
    history.replaceState(null, "", url.toString());
  }

  function adoptMagicIdentityFromUrl() {
    const params = new URLSearchParams(location.search);
    const token = params.get("magic");

    if (!token || !MAGIC_TOKEN_PATTERN.test(token)) return;

    clearMagicUrl();

    const username = (params.get("name") || "").trim();
    const identity = getIdentity();

    if (identity?.token === token) return;

    if (!identity) {
      const adoptedName = username || "Friend";

      saveIdentity({
        name: adoptedName,
        username: username || makeUsername(adoptedName),
        token,
        createdAt: Date.now(),
        isPlaceholder: false
      });

      magicWelcomeStatus =
        `Your magic link brought you home, ` +
        `${username || "Friend"} 💗`;

      return;
    }

    pendingMagicRestore = {
      token,
      username: username || null
    };

    setTimeout(() => {
      if (!pendingMagicRestore) return;

      $("restore-username").textContent =
        pendingMagicRestore.username || "the name on your link";
      showDialog($("restore-dialog"));
    }, MAGIC_RESTORE_DELAY_MS);
  }

  function forgetPendingMagicRestore() {
    pendingMagicRestore = null;
  }

  async function restoreMagicIdentity() {
    const pending = pendingMagicRestore;

    if (!pending) return;

    try {
      const identity = getOrCreateIdentity();
      const name = pending.username || identity.name;

      saveIdentity({
        name,
        username: pending.username || makeUsername(name),
        token: pending.token,
        createdAt: identity.createdAt,
        isPlaceholder: false
      });

      pendingMagicRestore = null;
      await closeDialog($("restore-dialog"));
      renderProfileBadge();
      setStatus(
        "Your magic link brought your sweet name home 💗"
      );
    } catch (error) {
      console.error("Could not restore from a magic link:", error);
      setStatus(
        "We couldn't switch to that magic link. Please try again 🍭"
      );
    }
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

      // Leave any previous note's edit state behind.
      resetNoteEdit();

      $("note-message").textContent =
        typeof message === "string" && message.trim()
          ? message
          : "This little candy doesn't have a saved note yet ♡";

      currentNote = {
        code,
        id: typeof record?.id === "string" ? record.id : null,
        message: typeof message === "string" ? message : "",
        isEditable: canEditCandy(code, record)
      };

      const editable = currentNote.isEditable;

      $("edit-note-button").hidden = !editable;
      $("delete-note-button").hidden = !editable;

      showDialog($("note-dialog"));
    } finally {
      openingCandy = false;
    }
  }

  /* ========================================================
     Editing a candy note
     ======================================================== */

  /*
   * The visitor's permanent identity token guards the whole jar; it
   * may edit any candy inside. Candies remember which identity added
   * them, so joiners can reword their own notes too. Only candies
   * stored one by one can be edited — the earliest format saved a
   * plain candy count with nothing to reword.
   */
  function canEditCandy(code, record) {
    const token = getIdentity()?.token;

    if (
      !token ||
      !record ||
      typeof record.id !== "string" ||
      typeof record.message !== "string"
    ) {
      return false;
    }

    try {
      const jar = getJar(readStore(), code);

      if (!jar || !Array.isArray(jar.candies)) return false;

      if (jar.ownerToken === token) return true;

      return record.authorToken === token;
    } catch (error) {
      console.error("Could not read candy owner:", error);
      return false;
    }
  }

  /*
   * Jars and candies created before the identity system referenced a
   * separate random owner token. Rewrite those references to the
   * visitor's identity token once, so existing ownership survives
   * the switch.
   */
  function migrateLegacyOwnerTokens() {
    const legacyToken = window.localStorage.getItem(
      LEGACY_OWNER_TOKEN_KEY
    );

    if (!legacyToken) return;

    const identityToken = getIdentity()?.token;

    if (!identityToken) {
      // Revisit once the welcome hello has created an identity.
      return;
    }

    if (identityToken === legacyToken) {
      window.localStorage.removeItem(LEGACY_OWNER_TOKEN_KEY);
      return;
    }

    try {
      const data = readStore();
      let changed = false;

      for (const jar of Object.values(data)) {
        if (jar?.ownerToken === legacyToken) {
          jar.ownerToken = identityToken;
          changed = true;
        }

        if (Array.isArray(jar?.candies)) {
          for (const candy of jar.candies) {
            if (candy?.authorToken === legacyToken) {
              candy.authorToken = identityToken;
              changed = true;
            }
          }
        }
      }

      if (changed) writeStore(data);
    } catch (error) {
      console.error("Could not migrate owner tokens:", error);
      return;
    }

    window.localStorage.removeItem(LEGACY_OWNER_TOKEN_KEY);
  }

  function setNoteEditCount() {
    const input = $("note-edit-input");
    $("note-edit-count").textContent =
      `${input.value.length} / ${MESSAGE_LIMIT}`;
  }

  function enterNoteEditMode() {
    if (!currentNote?.isEditable || addingCandy) return;

    const input = $("note-edit-input");

    input.value = currentNote.message;
    setNoteEditCount();
    clearError("note-edit-error");

    $("note-body").hidden = true;
    $("edit-note-button").hidden = true;
    $("delete-note-button").hidden = true;
    $("note-return-button").hidden = true;
    $("note-edit-form").hidden = false;

    input.focus({ preventScroll: true });

    // Put the caret at the end, ready for small tweaks.
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function exitNoteEditMode() {
    $("note-edit-form").hidden = true;
    $("note-body").hidden = false;
    $("edit-note-button").hidden = !currentNote?.isEditable;
    $("delete-note-button").hidden = !currentNote?.isEditable;
    $("note-return-button").hidden = false;
  }

  function resetNoteEdit() {
    currentNote = null;
    exitNoteEditMode();
    clearError("note-edit-error");
  }

  function cancelNoteEdit() {
    exitNoteEditMode();
    clearError("note-edit-error");
    $("edit-note-button").focus({ preventScroll: true });
  }

  /* ========================================================
     Deleting a candy note
     ======================================================== */

  function openDeleteCandyDialog() {
    // The delete button only appears to the candy's owner, so
    // reaching this page without one means the state moved on.
    if (!currentNote?.isEditable || addingCandy) return;

    showDialog($("delete-candy-dialog"));
  }

  async function deleteCurrentCandy() {
    const note = currentNote;
    const code = note?.code;
    const version = routeVersion;

    if (!note || !code) return;

    try {
      const data = readStore();
      const jar = getJar(data, code);

      if (!jar || !Array.isArray(jar.candies)) {
        await closeDialog($("delete-candy-dialog"));
        await closeDialog($("note-dialog"));
        setStatus("That candy is no longer in the jar 🍭");
        return;
      }

      // Re-reading storage here keeps a stale popup from erasing
      // something that changed since the note was opened.
      const records = getCandyRecords(jar);
      const index = records.findIndex(
        candy => candy.id === note.id
      );

      if (
        index === -1 ||
        !canEditCandy(code, records[index])
      ) {
        await closeDialog($("delete-candy-dialog"));
        await closeDialog($("note-dialog"));
        setStatus("Only the candy's owner can delete it 💗");
        return;
      }

      records.splice(index, 1);
      jar.candies = records;
      jar.capacity = CAPACITY;

      // Persist before the jar above updates, so nothing flickers
      // a candy that is already gone.
      writeStore(data);

      await closeDialog($("delete-candy-dialog"));

      // The popup closes along with the candy it was opened for.
      await closeDialog($("note-dialog"));

      if (version === routeVersion && activeCode === code) {
        renderPage(jar, code);

        void animateElement($("candy-count"), [
          { opacity: .4, transform: "translateY(3px)" },
          { opacity: 1, transform: "translateY(0)" }
        ], { duration: 220 });

        setStatus("One little candy said goodbye 🍭");
      }
    } catch (error) {
      console.error("Could not delete candy:", error);
      await closeDialog($("delete-candy-dialog"));
      await closeDialog($("note-dialog"));
      setStatus("We couldn't delete that candy. Please try again 🍭");
    }
  }

  async function saveNoteEdit() {
    const note = currentNote;

    if (!note?.isEditable) return;

    clearError("note-edit-error");

    const message = $("note-edit-input").value.trim();

    if (!message || message.length > MESSAGE_LIMIT) {
      showError(
        "note-edit-error",
        "Write a little kindness, up to 150 characters 💗"
      );
      $("note-edit-input").focus();
      return;
    }

    try {
      const data = readStore();
      const jar = getJar(data, note.code);

      if (!jar) {
        showError(
          "note-edit-error",
          "Oops! This candy is no longer available 🍭"
        );
        return;
      }

      const records = getCandyRecords(jar);
      const record = records.find(
        candy => candy.id === note.id
      );

      if (!canEditCandy(note.code, record)) {
        showError(
          "note-edit-error",
          "Only the note's author can edit it 💗"
        );
        return;
      }

      record.message = message;
      writeStore(data);

      resetNoteEdit();
      $("note-message").textContent = message;

      void animateElement($("note-message"), [
        { opacity: .35, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" }
      ], { duration: 240 });

      $("note-return-button").focus({ preventScroll: true });
      setStatus("Your note has a fresh new sparkle ✨");

      // Keep the jar page aligned with the saved text.
      if (activeCode === note.code) renderPage(jar, note.code);
    } catch (error) {
      console.error("Could not save note:", error);
      showError(
        "note-edit-error",
        "We couldn't save that note. Please try again 🍭"
      );
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

  function updateNameCount() {
    const input = $("edit-name-input");
    $("name-count").textContent = `${input.value.length} / ${NAME_LIMIT}`;
  }

  function openEditDialog() {
    if (!activeCode) return;

    let jar;

    try {
      jar = getJar(readStore(), activeCode);

      if (!isJarOwner(jar)) return;
    } catch (error) {
      console.error("Could not read jar owner:", error);
      return;
    }

    clearError("edit-error");

    const input = $("edit-name-input");
    input.value = jar.name.slice(0, NAME_LIMIT);
    updateNameCount();

    showDialog($("edit-dialog"));

    // Ready to retype the whole name straight away.
    input.focus();
    input.select();
  }

  function openDeleteDialog() {
    if (!activeCode) return;

    try {
      if (!isJarOwner(getJar(readStore(), activeCode))) return;
    } catch (error) {
      console.error("Could not read jar owner:", error);
      return;
    }

    showDialog($("delete-dialog"));
  }

  async function editJar() {
    clearError("edit-error");

    const code = activeCode;
    const name = $("edit-name-input").value.trim().slice(0, NAME_LIMIT);

    if (!code || !name) {
      showError("edit-error", "Give your jar a little name first 🎀");
      $("edit-name-input").focus();
      return;
    }

    try {
      const data = readStore();
      const jar = getJar(data, code);

      if (!jar || !isJarOwner(jar)) {
        showError("edit-error", "Only the jar owner can rename this jar 💗");
        return;
      }

      const previousName = jar.name;
      jar.name = name;
      writeStore(data);
      await closeDialog($("edit-dialog"));
      renderPage(jar, code);

      // The shelf re-reads storage each time it opens, so refresh it
      // too in case it is already on screen.
      if (isDrawerOpen()) renderJarsShelf();

      if (previousName === name) {
        setStatus("Your jar kept its lovely name 💗");
        return;
      }

      void animateElement($("jar-title"), [
        { opacity: .35, transform: "translateY(5px) scale(.97)" },
        { opacity: 1, transform: "translateY(0) scale(1)" }
      ], { duration: 320 });

      setStatus("Your jar has a fresh little name ✨");
    } catch (error) {
      console.error("Could not edit jar:", error);
      showError("edit-error", "We couldn't save that name. Please try again 🍭");
    }
  }

  async function deleteJar() {
    const code = activeCode;
    const version = routeVersion;

    if (!code) return;

    try {
      const data = readStore();
      const jar = getJar(data, code);

      if (!jar || !isJarOwner(jar)) {
        await closeDialog($("delete-dialog"));
        setStatus("Only the jar owner can delete this jar 💗");
        return;
      }

      delete data[code];
      writeStore(data);
      await closeDialog($("delete-dialog"));

      if (version === routeVersion) navigate();
    } catch (error) {
      console.error("Could not delete jar:", error);
      setStatus("We couldn't delete this jar. Please try again 🍭");
    }
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
    $("jar-owner-actions").hidden = !isJarOwner(jar);
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

    renderProfileBadge();

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
        name: name.slice(0, NAME_LIMIT),
        candies: [],
        capacity: CAPACITY,
        ownerToken: getOwnershipToken(),
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

    const type = document.querySelector(
      'input[name="candyType"]:checked'
    )?.value;

    if (!LIVE_CANDY_TYPES.includes(type)) {
      showError("add-error", "That candy kind isn't ready yet 🍬");
      return;
    }

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
        authorToken: getOwnershipToken(),
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
      setCandyType("text");

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

  $("edit-jar-button").addEventListener("click", openEditDialog);

  $("delete-jar-button").addEventListener("click", openDeleteDialog);

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

  $("edit-note-button").addEventListener("click", enterNoteEditMode);

  $("delete-note-button").addEventListener("click", openDeleteCandyDialog);

  $("note-edit-cancel").addEventListener("click", cancelNoteEdit);

  $("note-edit-input").addEventListener("input", () => {
    setNoteEditCount();
    clearError("note-edit-error");
  });

  // A closed note dialog should never reopen mid-edit.
  $("note-dialog").addEventListener("close", resetNoteEdit);

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

  $("edit-name-input").addEventListener("input", () => {
    clearError("edit-error");
    updateNameCount();
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

  document.querySelectorAll('input[name="candyType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;

      setCandyType(radio.value);

      // Jumping into the message keeps typing seamless on the way back.
      if (LIVE_CANDY_TYPES.includes(radio.value)) {
        $("message-input").focus();
      }
    });
  });

  $("profile-badge").addEventListener("click", openProfileDialog);

  $("get-magic-button").addEventListener("click", openMagicLinkDialog);

  $("magic-copy-button").addEventListener("click", () => {
    void copyMagicLink();
  });

  $("magic-link-dialog").addEventListener(
    "close",
    resetMagicCopyButton
  );

  $("restore-dialog").addEventListener(
    "close",
    forgetPendingMagicRestore
  );

  $("change-name-button").addEventListener("click", enterNameEditMode);

  $("name-cancel").addEventListener("click", cancelNameEdit);

  $("name-input").addEventListener("input", () => {
    setProfileNameCount();
    clearError("name-error");
  });

  bindSubmit("create-form", createJar);
  bindSubmit("welcome-form", submitWelcome);
  bindSubmit("name-form", saveNameChange);
  bindSubmit("join-form", joinJar);
  bindSubmit("add-form", addCandy);
  bindSubmit("edit-form", editJar);
  bindSubmit("delete-form", deleteJar);
  bindSubmit("delete-candy-form", deleteCurrentCandy);
  bindSubmit("note-edit-form", saveNoteEdit);
  bindSubmit("restore-form", restoreMagicIdentity);

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

  // Carry any pre-identity ownership over before the first render.
  migrateLegacyOwnerTokens();

  // A magic link restores the visitor's identity before anything
  // renders, so badge and jars are already theirs on first paint.
  adoptMagicIdentityFromUrl();

  // Everyone gets a first-visit hello unless they already
  // picked a name on a previous visit — a magic link counts too.
  if (!getIdentity()) {
    setTimeout(showWelcomeModal, 500);
  }

  renderRoute();

  if (magicWelcomeStatus) {
    // renderRoute clears the status line, greet after it settles.
    setTimeout(() => {
      setStatus(magicWelcomeStatus);
      magicWelcomeStatus = null;
    }, 100);
  }
})();
