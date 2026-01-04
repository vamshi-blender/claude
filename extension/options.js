const apiKeyEl = document.getElementById("api-key");
const modelEl = document.getElementById("model");
const saveEl = document.getElementById("save");
const statusEl = document.getElementById("status");

loadSettings().catch(() => {});

saveEl.addEventListener("click", async () => {
  const openaiApiKey = apiKeyEl.value.trim();
  const openaiModel = modelEl.value.trim();

  await chrome.storage.local.set({ openaiApiKey, openaiModel });
  statusEl.textContent = "Saved";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 1500);
});

async function loadSettings() {
  const { openaiApiKey, openaiModel } = await chrome.storage.local.get([
    "openaiApiKey",
    "openaiModel"
  ]);
  if (openaiApiKey) {
    apiKeyEl.value = openaiApiKey;
  }
  if (openaiModel) {
    modelEl.value = openaiModel;
  }
}
