import type { AgentProfile } from "@aware/shared";
import { useEffect, useState } from "react";
import { apiGet } from "../app/api";

export function AgentPicker({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	const [agents, setAgents] = useState<AgentProfile[]>([]);
	useEffect(() => {
		void apiGet<AgentProfile[]>("/agents").then((items) => {
			setAgents(items);
			const defaultAgent =
				items.find((agent) => agent.name === "Code") ?? items[0];
			if (!value && defaultAgent) onChange(defaultAgent.id);
		});
	}, [onChange, value]);
	return (
		<label className="agent-picker">
			Agent{" "}
			<select value={value} onChange={(e) => onChange(e.target.value)}>
				{agents.map((agent) => (
					<option key={agent.id} value={agent.id}>
						{agent.name}
					</option>
				))}
			</select>
		</label>
	);
}
