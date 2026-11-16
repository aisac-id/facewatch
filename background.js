// FaceWatch — toolbar icon opens the sentinel dashboard in a full tab.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});