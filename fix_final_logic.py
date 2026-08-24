import re

with open('extension/popup.js', 'r') as f:
    content = f.read()

# 1. Update checkPageStatus to remove title extraction completely
old_check = """        let meetingTitle = "Meeting";
        const titleEl = document.querySelector('[data-tid="meeting-title"], [data-tid="call-title"], .meeting-title, .call-title, [data-tid="chat-header-title"], #roster-title-text');
        if (titleEl && titleEl.innerText) {
            meetingTitle = titleEl.innerText.trim();
        } else if (document.title) {
            let extracted = document.title.split('|')[0].trim();
            const ignoreList = ['calendar', 'chat', 'teams', 'activity', 'calls', 'microsoft teams', 'onedrive', 'files'];
            if (extracted && !ignoreList.includes(extracted.toLowerCase())) {
                meetingTitle = extracted;
            }
        }
        return { captionsOn, meetingTitle };"""

new_check = """        return { captionsOn: captionsOn, meetingTitle: "Meeting" };"""

content = content.replace(old_check, new_check)

# 2. Update the prompt to include the title generation instruction
old_prompt = """Your output must be a well-structured set of meeting minutes that perfectly adheres to the required format.

1.  **Strict Formatting:** You must output the meeting minutes using the exact section headings provided below. Do not modify the section names. Each bullet must be a distinct section.
2.  **Date, time, and attendees:**"""

new_prompt = """Your output must be a well-structured set of meeting minutes that perfectly adheres to the required format.

1.  **Strict Formatting:** You must output the meeting minutes using the exact section headings provided below. Do not modify the section names. Each bullet must be a distinct section.
2.  **Title:** You must generate a short, concise title for the meeting based on the transcript (less than 7 words). It must be placed at the very beginning of the document in this exact format:
# Title
[Your Generated Title Here]
3.  **Date, time, and attendees:**"""

# Fix numbering for the rest of the prompt
content = content.replace(old_prompt, new_prompt)
content = content.replace("3.  **Meeting purpose:**", "4.  **Meeting purpose:**")
content = content.replace("4.  **Agenda items:**", "5.  **Agenda items:**")
content = content.replace("5.  **Key discussions:**", "6.  **Key discussions:**")
content = content.replace("6.  **Decisions made:**", "7.  **Decisions made:**")
content = content.replace("7.  **Action items:**", "8.  **Action items:**")
content = content.replace("8.  **Follow-ups:**", "9.  **Follow-ups:**")


# 3. Update the summary file saving logic
old_save = """      const data = await response.json();
      let minutesText = data.candidates[0].content.parts[0].text;
      
      const headerTitle = `# Title\\n${meetingTitle}\\n\\n`;
      minutesText = headerTitle + minutesText;
      
      // Sanitize title to lowercase with underscore for filename
      let sanitizedTitle = meetingTitle.toLowerCase()
        .replace(/[^a-z0-9\\s_-]/g, '')
        .trim()
        .replace(/[\\s-]+/g, '_')
        .substring(0, 50);
      
      if (!sanitizedTitle) sanitizedTitle = "meeting";
      
      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `summary_${sanitizedTitle}_${dateStr}.md`;"""

new_save = """      const data = await response.json();
      let minutesText = data.candidates[0].content.parts[0].text;
      
      let aiTitle = "meeting";
      const outLines = minutesText.split('\\n');
      for (let i = 0; i < outLines.length; i++) {
          if (outLines[i].toLowerCase().includes('# title') && i + 1 < outLines.length) {
              aiTitle = outLines[i+1].trim();
              if (!aiTitle && i + 2 < outLines.length) {
                  aiTitle = outLines[i+2].trim();
              }
              break;
          }
      }
      
      let sanitizedTitle = aiTitle.toLowerCase()
        .replace(/[^a-z0-9\\s_-]/g, '')
        .trim()
        .replace(/[\\s-]+/g, '_')
        .substring(0, 50);
      
      if (!sanitizedTitle || sanitizedTitle === 'title') sanitizedTitle = "meeting";
      
      const d = new Date();
      const dateStr = d.toISOString().split('T')[0];
      const timeStr = d.toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `ai_summary_${sanitizedTitle}_${dateStr}_${timeStr}.md`;"""

content = content.replace(old_save, new_save)


# 4. Update the transcript file saving logic
old_transcript_save = """  downloadBtn.addEventListener('click', () => {
    chrome.storage.local.get(['savedTranscript', 'meetingTitle'], (result) => {
      const transcript = result.savedTranscript || [];
      if (transcript.length === 0) {
        alert('No transcript available to download.');
        return;
      }
      const lines = transcript.map(item => `[${item.timestamp}] ${item.speaker}: ${item.text}`);
      const text = lines.join('\\n');
      
      const meetingTitle = result.meetingTitle || "meeting";
      let sanitizedTitle = meetingTitle.toLowerCase().replace(/[^a-z0-9\\s_-]/g, '').trim().replace(/[\\s-]+/g, '_');
      if (!sanitizedTitle) sanitizedTitle = "meeting";
      
      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `transcript_${sanitizedTitle}_${dateStr}.txt`;"""


new_transcript_save = """  downloadBtn.addEventListener('click', () => {
    chrome.storage.local.get(['savedTranscript'], (result) => {
      const transcript = result.savedTranscript || [];
      if (transcript.length === 0) {
        alert('No transcript available to download.');
        return;
      }
      const lines = transcript.map(item => `[${item.timestamp}] ${item.speaker}: ${item.text}`);
      const text = lines.join('\\n');
      
      const d = new Date();
      const dateStr = d.toISOString().split('T')[0];
      const timeStr = d.toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `transcript_${dateStr}_${timeStr}.txt`;"""

content = content.replace(old_transcript_save, new_transcript_save)

with open('extension/popup.js', 'w') as f:
    f.write(content)
