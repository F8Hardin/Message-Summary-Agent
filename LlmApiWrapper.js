const fetch = require("node-fetch");
const { OpenAI } = require("openai");
const { Agents } = require("openai-agents")
require("dotenv").config();

class LlmApiWrapper {
    constructor(tools) {
        this.model = process.env.MODEL;
        this.agentModel = process.env.AGENT_MODEL;
        this.baseUrl = process.env.LMSTUDIO_BASE_URL || "http://10.0.0.243:1234/v1/completions";
        this.messages = [];
        this.tools = tools;
        this.agent = null;

        if (!process.env.LMSTUDIO_AGENT){
            this.initAgent(tools);
            this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
            this.agents = new Agents({openai: this.openai})
        }
    }

    addMessage(messageJson) {
        this.messages.push(messageJson);
    }

    async callLLM(systemPrompt, userInput) {
        console.log(`Calling LM Studio (Model: ${this.model})...`);
    
        const requestBody = {
            model: this.model,
            prompt: `${systemPrompt}\n\n${userInput}`,
            max_tokens: 300
        };
    
        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });
    
            const data = await response.json();
            console.log("API Response:", JSON.stringify(data, null, 2));
    
            if (!data.choices || data.choices.length === 0 || !data.choices[0].text) {
                console.error("Unexpected API response format:", data);
                return "Error: No response from LLM.";
            }
    
            const aiResponse = data.choices[0].text.trim();
            return aiResponse;
        } catch (error) {
            console.error("Error calling LM Studio:", error);
            return "Error processing request.";
        }
    }

    async initAgent(tools) {
        if (this.agent) return this.agent;

        console.log("Initializing OpenAI Agent...");

        this.agent = await this.agents.createAgent({
            instructions: "You are a helpful assistant. Use the provided tools when necessary.",
            model: this.OPEN_AI_MODEL,
            tools: this.tools
        });

        return this.agent;
    }

    async callLmstudioAgent(userInput, tools = []) {
        console.log(`Calling LM Studio (Model: ${this.agentModel})...`);
    
        this.messages.push({ role: "user", content: userInput });
    
        const toolDescriptions = tools.map(t => `- ${t.function.name}: ${t.function.description}`).join("\n");
    
        // lmstudio agent is given system prompt in the lmstudio UI
        const requestBody = {
            model: this.agentModel,
            prompt: userInput,
            max_tokens: 500 
        };
    
        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });
    
            // parse json data to get commands and response
            const data = await response.json();
            console.log("API Response:", JSON.stringify(data, null, 2));
    
            if (!data.choices || data.choices.length === 0) {
                console.error("Unexpected API response format:", data);
                return { aiResponse: "AI response format error.", toolCalls: [] };
            }
    
            const aiResponse = data.choices[0].text.trim();
            
            // Enhanced JSON parsing with better error handling
            let toolCalls = [];
            try {
                // First try to parse the entire response as JSON
                const parsedResponse = JSON.parse(aiResponse);
                if (parsedResponse.function && parsedResponse.arguments) {
                    toolCalls.push({ function: parsedResponse });
                }
            } catch (error) {
                // If that fails, try to extract JSON from the response
                console.log("Initial JSON parsing failed, attempting to extract JSON from response");
                try {
                    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const jsonStr = jsonMatch[0];
                        const parsedJson = JSON.parse(jsonStr);
                        if (parsedJson.function && parsedJson.arguments) {
                            toolCalls.push({ function: parsedJson });
                        }
                    }
                } catch (extractError) {
                    console.error("Error extracting JSON from AI response:", extractError);
                }
            }
    
            // store and return to agent loop
            this.messages.push({ role: "assistant", content: aiResponse });
            return { aiResponse, toolCalls };
        } catch (error) {
            console.error("Error calling LM Studio:", error);
            return { aiResponse: "Error processing request.", toolCalls: [] };
        }
    }
    
    async callOpenAIAgent(userInput) {
        console.log(`Calling OpenAI Agent (Model: ${this.model})...`);

        this.messages.push({ role: "user", content: userInput });

        try {
            const response = await this.agent.run({ messages: this.messages });

            const finalMessage = response.choices?.[0]?.message;
            this.messages.push({ role: "assistant", ...finalMessage });

            return {
                aiResponse: finalMessage.content || "No content returned.",
                toolCalls: finalMessage.tool_calls || []
            };
        } catch (error) {
            console.error("Error calling OpenAI Agent:", error);
            return { aiResponse: "Error processing agent.", toolCalls: [] };
        }
    }
}

module.exports = LlmApiWrapper;
