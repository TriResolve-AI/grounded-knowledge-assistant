const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01';

/**
 * Call OpenAI or Azure OpenAI API with a prompt
 * @param {string} prompt - The user prompt
 * @param {string} model - Model name (default: gpt-3.5-turbo or deployment)
 * @returns {Promise<string>} - The assistant's response
 */
async function callOpenAI(prompt, model = 'gpt-3.5-turbo') {
    if (AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY && AZURE_OPENAI_DEPLOYMENT) {
        const azureUrl = `${AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
        try {
            const response = await axios.post(
                azureUrl,
                {
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.7,
                    max_tokens: 1000
                },
                {
                    headers: {
                        'api-key': AZURE_OPENAI_KEY,
                        'Content-Type': 'application/json',
                    },
                }
            );

            return response.data.choices[0].message.content;
        } catch (error) {
            throw new Error(`Azure OpenAI API error: ${error.message}`);
        }
    }

    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY or Azure OpenAI credentials are not set');
    }

    try {
        const response = await axios.post(
            OPENAI_API_URL,
            {
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7,
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        return response.data.choices[0].message.content;
    } catch (error) {
        throw new Error(`OpenAI API error: ${error.message}`);
    }
}


/**
 * Enhance a query for better semantic search
 * @param {string} query - The original query
 * @returns {Promise<string>} - The enhanced query
 */
async function enhanceQuery(query) {
    const enhancementPrompt = `Enhance this search query for finding governance and compliance tools. Make it more specific and semantic: "${query}"`;
    try {
        return await callOpenAI(enhancementPrompt);
    } catch (error) {
        console.warn('[OPENAI] enhanceQuery fallback: ', error.message);
        // Graceful fallback if OpenAI/Azure is unavailable
        return query;
    }
}

module.exports = {
    callOpenAI,
    enhanceQuery,
};