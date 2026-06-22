const { VertexAI } = require('@google-cloud/vertexai');
const cors = require('cors')({ origin: true });

exports.generateMinutes = (req, res) => {
  // Handle CORS for Chrome Extension requests
  cors(req, res, async () => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const transcript = req.body.transcript;
    if (!transcript) return res.status(400).send('Transcript is required');

    try {
      // Initialize Vertex AI
      // The Cloud Function environment automatically uses the default service account credentials.
      const vertex_ai = new VertexAI({ project: process.env.GCP_PROJECT, location: 'us-central1' });
      const generativeModel = vertex_ai.preview.getGenerativeModel({
        model: 'gemini-1.5-pro-preview-0409',
        generationConfig: { temperature: 0.2 }
      });

      const prompt = `You are an executive assistant. Create concise meeting minutes from the following transcript. Include: 1. Meeting Summary 2. Key Decisions 3. Action Items.\n\nTranscript:\n${transcript}`;

      const response = await generativeModel.generateContent(prompt);
      const outputText = response.response.candidates[0].content.parts[0].text;
      
      res.status(200).json({ minutes: outputText });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to generate minutes' });
    }
  });
};
