import re

with open('extension/popup.js', 'r') as f:
    content = f.read()

# Fix checkPageStatus
old_check = """        let meetingTitle = "Meeting";
        if (document.title) {
            let extracted = document.title.split('|')[0].trim();
            if (extracted && !extracted.toLowerCase().includes('microsoft teams')) {
                meetingTitle = extracted;
            }
        }"""

new_check = """        let meetingTitle = "Meeting";
        const titleEl = document.querySelector('[data-tid="meeting-title"], [data-tid="call-title"], .meeting-title, .call-title, [data-tid="chat-header-title"], #roster-title-text');
        if (titleEl && titleEl.innerText) {
            meetingTitle = titleEl.innerText.trim();
        } else if (document.title) {
            let extracted = document.title.split('|')[0].trim();
            const ignoreList = ['calendar', 'chat', 'teams', 'activity', 'calls', 'microsoft teams', 'onedrive', 'files'];
            if (extracted && !ignoreList.includes(extracted.toLowerCase())) {
                meetingTitle = extracted;
            }
        }"""

content = content.replace(old_check, new_check)

# Fix prompt
old_prompt = """Your output must be a well-structured set of meeting minutes that perfectly adheres to the required format.

# ${meetingTitle}
1.  **Strict Formatting:**"""

new_prompt = """Your output must be a well-structured set of meeting minutes that perfectly adheres to the required format.

1.  **Strict Formatting:**"""

content = content.replace(old_prompt, new_prompt)


# Fix save logic
old_save = """      const data = await response.json();
      const minutesText = data.candidates[0].content.parts[0].text;"""

new_save = """      const data = await response.json();
      let minutesText = data.candidates[0].content.parts[0].text;
      
      const headerTitle = `# Title\\n${meetingTitle}\\n\\n`;
      minutesText = headerTitle + minutesText;"""

content = content.replace(old_save, new_save)

with open('extension/popup.js', 'w') as f:
    f.write(content)
