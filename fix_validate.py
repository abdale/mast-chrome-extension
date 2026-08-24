import re

with open('extension/popup.js', 'r') as f:
    content = f.read()

old_validate = """async function validateApiKey(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  try {
    const response = await fetch(url);
    return response.ok;
  } catch (error) {
    return false;
  }
}

validateBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiError.innerText = "Key cannot be empty.";
    apiError.style.display = "block";
    return;
  }
  
  validateBtn.innerText = "Validating...";
  validateBtn.disabled = true;
  apiError.style.display = "none";
  
  chrome.storage.local.get(['selectedModel'], async (result) => {
    const isValid = await validateApiKey(key);
    
    if (isValid) {
      if (!result.selectedModel) {
        chrome.storage.local.set({ selectedModel: 'gemini-3.5-flash-lite' });
      }
      chrome.storage.local.set({ apiKey: key }, () => {
        updateUI();
      });
    } else {
      apiError.innerText = `Invalid API Key. Please try again.`;
      apiError.style.display = "block";
      validateBtn.innerText = "Save & Validate";
      validateBtn.disabled = false;
    }
  });
});"""

new_validate = """async function validateApiKey(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { valid: false, flashLiteModel: null };
    const data = await response.json();
    const validModels = data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"));
    
    const matches = validModels.filter(m => {
      const name = m.name.toLowerCase();
      return name.includes('flash-lite') && !name.includes('latest') && !name.includes('tuning') && !name.includes('embed');
    });
    
    matches.sort((a, b) => {
      const aExp = a.name.includes('exp') || a.name.includes('preview');
      const bExp = b.name.includes('exp') || b.name.includes('preview');
      if (aExp && !bExp) return 1;
      if (!aExp && bExp) return -1;
      return b.name.localeCompare(a.name);
    });
    
    const defaultModel = matches.length > 0 ? matches[0].name.replace('models/', '') : 'gemini-2.0-flash-lite-001';
    
    return { valid: true, flashLiteModel: defaultModel };
  } catch (error) {
    return { valid: false, flashLiteModel: null };
  }
}

validateBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiError.innerText = "Key cannot be empty.";
    apiError.style.display = "block";
    return;
  }
  
  validateBtn.innerText = "Validating...";
  validateBtn.disabled = true;
  apiError.style.display = "none";
  
  chrome.storage.local.get(['selectedModel'], async (result) => {
    const validation = await validateApiKey(key);
    
    if (validation.valid) {
      if (!result.selectedModel) {
        chrome.storage.local.set({ selectedModel: validation.flashLiteModel });
      }
      chrome.storage.local.set({ apiKey: key }, () => {
        updateUI();
      });
    } else {
      apiError.innerText = `Invalid API Key. Please try again.`;
      apiError.style.display = "block";
      validateBtn.innerText = "Save & Validate";
      validateBtn.disabled = false;
    }
  });
});"""

content = content.replace(old_validate, new_validate)

with open('extension/popup.js', 'w') as f:
    f.write(content)
