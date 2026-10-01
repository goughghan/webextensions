/* global browser */

async function getFromStorage(type, id, fallback) {
  let tmp = await browser.storage.local.get(id);
  return typeof tmp[id] === type ? tmp[id] : fallback;
}

async function setToStorage(id, value) {
  let obj = {};
  obj[id] = value;
  return browser.storage.local.set(obj);
}

(async () => {
  const temporary = browser.runtime.id.endsWith("@temporary-addon"); // debugging?
  const manifest = browser.runtime.getManifest();
  const extname = manifest.name;
  let manually_disabled = false;
  let mode = false;
  let regexList = [];

  async function getMode() {
    return await getFromStorage("boolean", "mode", false);
  }

  async function getRegexList() {
    let out = [];
    let tmp = await getFromStorage("string", "matchers", "");

    tmp.split("\n").forEach((line) => {
      line = line.trim();
      if (line !== "" && !line.startsWith("#")) {
        try {
          line = new RegExp(line.trim());
          out.push(line);
        } catch (e) {
          console.error(e);
        }
      }
    });
    return out;
  }

  function matchesRegEx(url) {
    for (let i = 0; i < regexList.length; i++) {
      if (regexList[i].test(url)) {
        return true;
      }
    }
    return false;
  }

  function updateBadge() {
    if (!manually_disabled) {
      browser.browserAction.setBadgeText({ text: "on" });
      browser.browserAction.setBadgeBackgroundColor({
        color: [0, 115, 0, 115],
      });
      browser.browserAction.setTitle({
        title: `${extname}: ON (click to disable)`,
      });
    } else {
      browser.browserAction.setBadgeText({ text: "off" });
      browser.browserAction.setBadgeBackgroundColor({
        color: [115, 0, 0, 115],
      });
      browser.browserAction.setTitle({
        title: `${extname}: OFF (click to enable)`,
      });
    }
  }

  async function onStorageChange(/*changes, area*/) {
    manually_disabled = await getFromStorage(
      "boolean",
      "manually_disabled",
      false,
    );
    updateBadge();
    mode = await getMode();
    regexList = await getRegexList();
  }

  await onStorageChange();

  // -------------------------------

  let wasActive = new Set();

  function shouldDiscard(tab) {
    if (
      typeof tab.id !== "number" ||
      tab.discarded ||
      tab.active ||
      tab.hidden ||
      wasActive.has(tab.id) ||
      manually_disabled ||
      !tab.url?.startsWith("http")
    ) {
      return false;
    }

    const mre = matchesRegEx(tab.url);
    return (
      (mode && mre) || // blacklist(true) => matches are not allowed to load
      (!mode && !mre) // whitelist(false) => matches are allowed to load <=> no match => not allowed
    );
  }

  function discardIfNeeded(tab) {
    if (shouldDiscard(tab)) {
      // A tab can become active or close between query/onUpdated and discard.
      // In either case there is nothing to do.
      browser.tabs.discard(tab.id).catch(() => {});
    }
  }

  browser.tabs.onUpdated.addListener(
    (tabId, changeInfo, tab) => {
      discardIfNeeded(tab);
    },
    { properties: ["url"] },
  );

  // Firefox may create fixed homepage tabs before this background script is
  // ready. Apply the same rule once to those already-created background tabs.
  browser.tabs.query({}).then((tabs) => tabs.forEach(discardIfNeeded));

  browser.tabs.onActivated.addListener((activeInfo) => {
    if (!wasActive.has(activeInfo.tabId)) {
      wasActive.add(activeInfo.tabId);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    if (wasActive.has(tabId)) {
      wasActive.delete(tabId);
    }
  });

  browser.storage.onChanged.addListener(onStorageChange);
  browser.browserAction.onClicked.addListener(() => {
    manually_disabled = !manually_disabled;
    updateBadge();
    setToStorage("manually_disabled", manually_disabled);
  });
})();

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    browser.runtime.openOptionsPage();
  } else {
    // Migrate old data (only if there is old data and it hasn't been migrated yet)
    let oldSelectors = await getFromStorage("object", "selectors", null);
    let existingMatchers = await getFromStorage("string", "matchers", "");
    if (
      Array.isArray(oldSelectors) &&
      oldSelectors.length > 0 &&
      existingMatchers === ""
    ) {
      let migrated = oldSelectors.map((e) => e.url_regex).join("\n");
      await setToStorage("matchers", migrated);
      await browser.storage.local.remove("selectors");
    }
  }
});
