"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
	id: string;
	role: "user" | "assistant" | "status" | "error";
	content: string;
}

interface Settings {
	model: string;
	tone: string;
}

export default function Home() {
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [status, setStatus] = useState<string>("");
	const [settings, setSettings] = useState<Settings>({
		model: "gpt-5.2",
		tone: "professional",
	});
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const scrollToBottom = () => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	};

	useEffect(() => {
		scrollToBottom();
	}, [messages]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!input.trim() || isLoading) return;

		const userMessage: Message = {
			id: Date.now().toString(),
			role: "user",
			content: input.trim(),
		};

		setMessages((prev) => [...prev, userMessage]);
		setInput("");
		setIsLoading(true);

		const assistantMessage: Message = {
			id: (Date.now() + 1).toString(),
			role: "assistant",
			content: "",
		};
		setMessages((prev) => [...prev, assistantMessage]);

		try {
			const response = await fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [...messages, userMessage].map((m) => ({
						role: m.role,
						content: m.content,
					})),
					model: settings.model,
					tone: settings.tone,
				}),
			});

			if (!response.ok) throw new Error("Failed to send message");

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No reader");

			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = JSON.parse(line.slice(6));
						if (data.type === "content") {
							setStatus("");
							setMessages((prev) =>
								prev.map((m) =>
									m.id === assistantMessage.id
										? { ...m, content: m.content + data.content }
										: m
								)
							);
						} else if (data.type === "status") {
							setStatus(data.content);
						} else if (data.type === "warning") {
							setStatus(`⚠️ ${data.content}`);
						} else if (data.type === "error") {
							setStatus("");
							setMessages((prev) =>
								prev.map((m) =>
									m.id === assistantMessage.id
										? { ...m, role: "error", content: data.content }
										: m
								)
							);
						} else if (data.type === "done") {
							setStatus("");
						}
					}
				}
			}
		} catch (err) {
			const error = err as Error;
			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessage.id
						? { ...m, role: "error", content: `Connection failed: ${error.message}` }
						: m
				)
			);
		} finally {
			setIsLoading(false);
			setStatus("");
		}
	};

	const clearChat = () => {
		setMessages([]);
	};

	return (
		<div className="h-screen overflow-hidden bg-[#0c0c0c] text-[#e0e0e0] flex">
			<div className="flex-1 flex flex-col max-w-3xl mx-auto p-6 h-full">
				<div className="flex-shrink-0 flex justify-between items-center mb-6">
					<h1 className="text-lg tracking-tight text-[#888]">techgear support</h1>
					<div className="flex gap-2">
						{messages.length > 0 && (
							<button
								onClick={clearChat}
								className="p-2 rounded-lg text-[#666] hover:text-[#999] hover:bg-[#1a1a1a] transition-all"
								title="Clear chat"
							>
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
									<path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
								</svg>
							</button>
						)}
						<button
							onClick={() => setShowSettings(!showSettings)}
							className={`p-2 rounded-lg transition-all ${
								showSettings
									? "bg-[#252525] text-white"
									: "text-[#666] hover:text-[#999] hover:bg-[#1a1a1a]"
							}`}
							title="Settings"
						>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<circle cx="12" cy="12" r="3" />
								<path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
							</svg>
						</button>
					</div>
				</div>

				<div className="flex-1 min-h-0 overflow-y-auto mb-4 space-y-4">
					{messages.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full text-center">
							<div className="w-16 h-16 mb-4 rounded-full bg-[#1a1a1a] flex items-center justify-center">
								<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="1.5">
									<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
								</svg>
							</div>
							<h2 className="text-[#888] text-lg mb-2">How can I help you today?</h2>
							<p className="text-[#555] text-sm max-w-md">
								Ask about our products, check order status, get technical support, or anything else related to TechGear.
							</p>
						</div>
					) : (
						messages.map((message) => (
							<div
								key={message.id}
								className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
							>
								<div
									className={`max-w-[80%] px-4 py-3 rounded-xl ${
										message.role === "user"
											? "bg-[#2563eb] text-white"
											: message.role === "error"
											? "bg-red-500/10 border border-red-500/30 text-red-400"
											: "bg-[#1a1a1a] border border-[#252525]"
									}`}
								>
									{message.role === "error" && (
										<p className="text-xs text-red-500 mb-1 font-medium">Error</p>
									)}
									<p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content || "..."}</p>
								</div>
							</div>
						))
					)}
					<div ref={messagesEndRef} />
				</div>

				{status && (
					<div className="flex-shrink-0 mb-2 px-3 py-2 bg-[#1a1a1a] border border-[#252525] rounded-lg">
						<p className="text-xs text-[#888]">{status}</p>
					</div>
				)}

				<form onSubmit={handleSubmit} className="flex-shrink-0 relative">
					<input
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder="Type your message..."
						disabled={isLoading}
						className="w-full py-4 px-5 pr-14 bg-[#1a1a1a] border border-[#252525] rounded-xl text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#333] transition-colors"
					/>
					<button
						type="submit"
						disabled={!input.trim() || isLoading}
						className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-all ${
							!input.trim() || isLoading
								? "text-[#444] cursor-not-allowed"
								: "text-[#2563eb] hover:bg-[#252525]"
						}`}
					>
						{isLoading ? (
							<div className="w-5 h-5 border-2 border-[#444] border-t-[#888] rounded-full animate-spin" />
						) : (
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
							</svg>
						)}
					</button>
				</form>
			</div>

			{showSettings && (
				<div className="w-72 h-full border-l border-[#252525] p-6 bg-[#0c0c0c] flex-shrink-0 overflow-y-auto">
					<h2 className="text-sm text-[#888] mb-6">Settings</h2>

					<div className="space-y-6">
						<div>
							<label className="block text-xs text-[#666] mb-2">Model</label>
							<select
								value={settings.model}
								onChange={(e) => setSettings({ ...settings, model: e.target.value })}
								className="w-full py-2 px-3 bg-[#1a1a1a] border border-[#252525] rounded-lg text-sm text-[#e0e0e0] focus:outline-none focus:border-[#333]"
							>
								<option value="gpt-5.2">GPT-5.2</option>
								<option value="gpt-5-mini">GPT-5-mini</option>
								<option value="gpt-5-nano">GPT-5-nano</option>
							</select>
						</div>

						<div>
							<label className="block text-xs text-[#666] mb-2">Tone</label>
							<select
								value={settings.tone}
								onChange={(e) => setSettings({ ...settings, tone: e.target.value })}
								className="w-full py-2 px-3 bg-[#1a1a1a] border border-[#252525] rounded-lg text-sm text-[#e0e0e0] focus:outline-none focus:border-[#333]"
							>
								<option value="professional">Professional</option>
								<option value="friendly">Friendly</option>
								<option value="concise">Concise</option>
							</select>
						</div>

						<div className="pt-4 border-t border-[#252525]">
							<p className="text-xs text-[#555]">
								Powered by OpenAI & MCP
							</p>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
