// Session transcript processor using Claude
// POST { transcript, format (grow/clear/oskar), clientName, sessionDate, coachId }
// Returns structured notes in the selected framework

import { logAIUsage } from '../lib/ai-usage.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    console.error('[process-session] ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'AI service not configured. ANTHROPIC_API_KEY missing.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { transcript, format, clientName, sessionDate, coachId } = body;

    if (!transcript || !format) {
      return res.status(400).json({ error: 'Missing transcript or format' });
    }

    const frameworks = {
      grow: {
        name: 'GROW',
        sections: ['Goal', 'Reality', 'Options', 'Way Forward'],
        descriptions: {
          'Goal': 'What the client wanted from this session',
          'Reality': 'Current situation and context since last session',
          'Options': 'What possibilities were explored',
          'Way Forward': 'What the client committed to do next'
        }
      },
      clear: {
        name: 'CLEAR',
        sections: ['Contract', 'Listen', 'Explore', 'Action', 'Review'],
        descriptions: {
          'Contract': 'What was agreed for the session',
          'Listen': 'Key themes and patterns that emerged',
          'Explore': 'What was discovered or challenged',
          'Action': 'What the client will do next',
          'Review': 'How the session landed for the client'
        }
      },
      oskar: {
        name: 'OSKAR',
        sections: ['Outcome', 'Scaling', 'Know-how', 'Affirm & Action', 'Review'],
        descriptions: {
          'Outcome': 'Desired outcome for the session',
          'Scaling': 'Where the client rated themselves and why',
          'Know-how': 'Strengths and resources identified',
          'Affirm & Action': 'Affirmations given and actions committed to',
          'Review': 'What worked well in this session'
        }
      }
    };

    const fw = frameworks[format];
    if (!fw) return res.status(400).json({ error: 'Invalid format. Use: grow, clear, or oskar' });

    const sectionList = fw.sections.map(s => `"${s}": "${fw.descriptions[s]}"`).join(', ');

    const systemPrompt = `You are a professional coaching note assistant. Extract and structure session notes in the ${fw.name} framework from the provided transcript or notes.

Use coaching language — forward-focused, strength-based, non-clinical. Be concise and specific. Write in third person (e.g. "The client expressed..." not "You expressed...").

Return ONLY valid JSON with these exact keys: {${sectionList}}

Each value should be 2-4 sentences capturing the essence of that section from the transcript. If a section isn't clearly covered in the transcript, write a brief note like "Not explicitly addressed in this session."`;

    const userMessage = `Client: ${clientName || 'Client'}
Session Date: ${sessionDate || 'Not specified'}

Transcript/Notes:
${transcript}`;

    console.log('[process-session] Calling Claude with format:', format, 'transcript length:', transcript.length);

    const model = 'claude-sonnet-4-6';
    const _startTime = Date.now();
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: userMessage }],
        system: systemPrompt
      })
    });

    const claudeData = await claudeRes.json().catch(function() { return null; });
    await logAIUsage({
      feature: 'session_processor',
      coachId: coachId || null,
      model: (claudeData && claudeData.model) || model,
      usage: claudeData && claudeData.usage,
      requestId: claudeData && claudeData.id,
      status: claudeRes.ok ? 'success' : 'error',
      errorMessage: claudeRes.ok ? null : (claudeData && claudeData.error && claudeData.error.message),
      durationMs: Date.now() - _startTime,
    });

    if (!claudeRes.ok) {
      console.error('[process-session] Claude API error:', claudeRes.status, claudeData);
      return res.status(502).json({ error: 'AI processing failed', details: claudeData });
    }

    const responseText = (claudeData && claudeData.content?.[0]?.text) || '';
    console.log('[process-session] Claude response length:', responseText.length);

    // Parse JSON from response (handle markdown code blocks)
    let structuredNotes;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      structuredNotes = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[process-session] JSON parse failed:', parseErr.message);
      // Fall back to raw text split into sections
      structuredNotes = {};
      fw.sections.forEach(s => { structuredNotes[s] = responseText; });
    }

    return res.status(200).json({
      format: format,
      frameworkName: fw.name,
      sections: fw.sections,
      notes: structuredNotes
    });
  } catch (e) {
    console.error('[process-session] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
