// Enhanced LlmApiWrapper with robust parsing and fallback mechanisms
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { OpenAIAgent } from 'openai-agents';
import dotenv from 'dotenv';
dotenv.config();

class LlmApiWrapper {
    constructor(tools) {
        this.model = process.env.MODEL;
        this.agentModel = process.env.AGENT_MODEL;
        this.baseUrl = process.env.LMSTUDIO_BASE_URL || "http://10.0.0.243:1234/v1/completions";
        this.messages = [
            {
              role: "system",
              content:
                "You are a helpful assistant. Only use the functions you have been provided with.",
            },
        ];
        this.tools = tools;
        this.agent = null;
        if (process.env.LMSTUDIO_AGENT == "false"){
            this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
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

    async callAgent(userInput){
        if (process.env.LMSTUDIO_AGENT == "false"){
            return await this.callOpenAIAgent(userInput);
        } else {
            return await this.callLmstudioAgent(userInput)
        }
    }

    //for interaction with local lmstudio model, needs work
    async callLmstudioAgent(userInput) {
        console.log(`🚀 Calling LM Studio (Model: ${this.agentModel})...`);
    
        this.messages.push({ role: "user", content: userInput });
    
        const toolDescriptions = this.tools.map(t => `- ${t.function.name}: ${t.function.description}`).join("\n");
    
        // Create a simplified system prompt that's more forgiving
        const systemPrompt = `You are an AI assistant that processes emails. Available functions:
        - getEmails(): Fetches unread emails
        - processEmail(email): Summarizes and classifies an email
        - markAsRead(emailUID): Marks an email as read
        - showUser(data): Displays results to the user
        
        When asked to process emails, first get the emails, then process each one, mark them as read, and show results to the user.`;
        
        const requestBody = {
            model: this.agentModel,
            prompt: `${systemPrompt}\n\n${userInput}`,
            max_tokens: 500,
            temperature: 0.3  // Lower temperature for more consistent outputs
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
            
            // Enhanced response processing with multiple fallback mechanisms
            let toolCalls = [];
            
            // Attempt 1: Try to parse the entire response as JSON
            try {
                const parsedResponse = JSON.parse(aiResponse);
                if (parsedResponse.function && parsedResponse.arguments) {
                    toolCalls.push({ function: parsedResponse });
                    console.log("Successfully parsed complete JSON response");
                }
            } catch (error) {
                console.log("Response is not a complete JSON object, trying alternative parsing methods");
                
                // Attempt 2: Try to extract JSON from the response
                try {
                    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const jsonStr = jsonMatch[0];
                        const parsedJson = JSON.parse(jsonStr);
                        if (parsedJson.function && parsedJson.arguments) {
                            toolCalls.push({ function: parsedJson });
                            console.log("Successfully extracted JSON from response");
                        }
                    }
                } catch (extractError) {
                    console.log("Could not extract valid JSON, trying natural language parsing");
                }
                
                // Attempt 3: Natural language parsing for common patterns
                if (toolCalls.length === 0) {
                    // Check for getEmails intent
                    if (aiResponse.toLowerCase().includes("get emails") || 
                        aiResponse.toLowerCase().includes("fetch emails") ||
                        aiResponse.toLowerCase().includes("retrieve emails") ||
                        aiResponse.toLowerCase().includes("check emails")) {
                        toolCalls.push({ 
                            function: {
                                name: "getEmails",
                                arguments: {}
                            }
                        });
                        console.log("Detected getEmails intent from natural language");
                    }
                    // Check for processEmail intent
                    else if (aiResponse.toLowerCase().includes("process email") || 
                             aiResponse.toLowerCase().includes("summarize email") ||
                             aiResponse.toLowerCase().includes("classify email")) {
                        // This is a simplified version - in a real implementation, you'd
                        // need to extract the email details from the response
                        toolCalls.push({ 
                            function: {
                                name: "processEmail",
                                arguments: {
                                    email: {
                                        subject: "Extracted from response",
                                        body: "Extracted from response"
                                    }
                                }
                            }
                        });
                        console.log("Detected processEmail intent from natural language");
                    }
                    // Check for markAsRead intent
                    else if (aiResponse.toLowerCase().includes("mark as read") || 
                             aiResponse.toLowerCase().includes("mark email as read")) {
                        toolCalls.push({ 
                            function: {
                                name: "markAsRead",
                                arguments: {
                                    emailUID: "latest" // Simplified - would need to extract the actual UID
                                }
                            }
                        });
                        console.log("Detected markAsRead intent from natural language");
                    }
                    // Check for showUser intent
                    else if (aiResponse.toLowerCase().includes("show user") || 
                             aiResponse.toLowerCase().includes("display results") ||
                             aiResponse.toLowerCase().includes("show results")) {
                        toolCalls.push({ 
                            function: {
                                name: "showUser",
                                arguments: {
                                    emails: [] // Simplified - would need to extract the actual emails
                                }
                            }
                        });
                        console.log("Detected showUser intent from natural language");
                    }
                    // Default fallback for initial prompt
                    else if (userInput.toLowerCase().includes("process emails") ||
                             userInput.toLowerCase().includes("get my emails")) {
                        toolCalls.push({ 
                            function: {
                                name: "getEmails",
                                arguments: {}
                            }
                        });
                        console.log("Using default fallback to getEmails based on user input");
                    }
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
        console.log(`Calling OpenAI Agent (Model: ${this.OPEN_AI_MODEL})...`);
    
        this.messages.push({
            role: "user",
            content: userInput,
        });
    
        try {
            const response = await this.openai.chat.completions.create({
                model: process.env.OPEN_AI_MODEL,
                messages: this.messages,
                tools: this.tools,
                tool_choice: "auto"
            });
    
            return response;
        } catch (error) {
            console.error("Error calling OpenAI Agent:", error);
            return { choices: [("failed", "failed")] };
        }
    }
    
}

module.exports = LlmApiWrapper;
