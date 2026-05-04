export function BusyIndicator({ label = "Loading" }: { label?: string }) {
	return (
		<span className="busy-indicator" role="status" aria-live="polite">
			<span className="busy-dot" aria-hidden="true" />
			{label}
		</span>
	);
}
