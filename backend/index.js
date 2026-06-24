const { VertexAI } = require('@google-cloud/vertexai');
const cors = require('cors')({ origin: true });

exports.generateMinutes = (req, res) => {
  // Handle CORS for Chrome Extension requests
  cors(req, res, async () => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const transcript = req.body.transcript;
    if (!transcript) return res.status(400).send('Transcript is required');

    try {
      // Initialize Agent Platform
      // The Cloud Function environment automatically uses the default service account credentials.
      const agentPlatform = new VertexAI({ project: process.env.GCP_PROJECT, location: 'us-central1' });
      const generativeModel = agentPlatform.preview.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
        generationConfig: { temperature: 0.2 }
      });

      let dateObj = new Date();
      if (req.body.date) {
        dateObj = new Date(req.body.date);
      }
      const dateFormatted = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) + ' at ' + dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

      const prompt = `You are an expert executive assistant. Generate professional, comprehensive meeting minutes from the provided transcript.
Do NOT use Markdown formatting (no asterisks, no hashes, etc.). Use raw plain text only.

FORMAT REQUIREMENTS:
- Meeting Title: Create a descriptive title for the meeting at the very top.
- Date and Time: ${dateFormatted}
- Attendees: List all attendees based on the transcript. Make a strong effort to deduce and include the company they work for next to their name (e.g., John Smith (Google)).
- Meeting Summary: A detailed summary of the discussion. Explicitly mention attendee names when attributing points so we do not lose track of who said what.
- Key Decisions: Clear decisions made, referencing the people involved.
- Action Items: Clear tasks. You MUST attribute every action item to a specific attendee by name.

Transcript:
${transcript}`;

      const response = await generativeModel.generateContent(prompt);
      const outputText = response.response.candidates[0].content.parts[0].text;
      
      res.status(200).json({ minutes: outputText });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to generate minutes' });
    }
  });
};
