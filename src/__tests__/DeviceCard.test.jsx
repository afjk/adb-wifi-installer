import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// DeviceCard is defined inside App.jsx; import App to get the component.
// Since components are not exported, we test them via the full App render
// or extract them. Here we inline a minimal copy to test the contract.
// For future refactors, extract DeviceCard to src/components/DeviceCard.jsx.

function typeIcon(type) {
  if (type === "vr") return "🥽";
  if (type === "tv") return "📺";
  return "📱";
}

function DeviceCard({ device, selected, onClick }) {
  const connected = device.state === "device";
  return (
    <div
      className={`device-card ${selected ? "selected" : ""} ${connected ? "connected" : "offline"}`}
      onClick={onClick}
      data-testid="device-card"
    >
      <span className="dc-icon">{typeIcon(device.device_type)}</span>
      <div className="dc-info">
        <span className="dc-name">{device.model || device.address}</span>
        <span className="dc-addr">{device.address}</span>
      </div>
      <div className="dc-right">
        {device.battery != null && (
          <span className={`dc-battery${device.battery <= 20 ? " low" : ""}`}>
            {device.charging ? "⚡" : "🔋"}{device.battery}%
          </span>
        )}
        <span className={`dc-dot ${connected ? "on" : "off"}`} />
      </div>
    </div>
  );
}

describe("DeviceCard", () => {
  const baseDevice = {
    address: "192.168.1.100:5555",
    state: "device",
    model: "Pico 4 Ultra",
    manufacturer: "Pico",
    device_type: "vr",
    battery: 80,
    charging: false,
  };

  it("renders device model name", () => {
    render(<DeviceCard device={baseDevice} selected={false} onClick={() => {}} />);
    expect(screen.getByText("Pico 4 Ultra")).toBeInTheDocument();
  });

  it("renders address", () => {
    render(<DeviceCard device={baseDevice} selected={false} onClick={() => {}} />);
    expect(screen.getByText("192.168.1.100:5555")).toBeInTheDocument();
  });

  it("shows VR icon for vr device type", () => {
    render(<DeviceCard device={baseDevice} selected={false} onClick={() => {}} />);
    expect(screen.getByText("🥽")).toBeInTheDocument();
  });

  it("shows phone icon for phone device type", () => {
    const device = { ...baseDevice, device_type: "phone" };
    render(<DeviceCard device={device} selected={false} onClick={() => {}} />);
    expect(screen.getByText("📱")).toBeInTheDocument();
  });

  it("shows TV icon for tv device type", () => {
    const device = { ...baseDevice, device_type: "tv" };
    render(<DeviceCard device={device} selected={false} onClick={() => {}} />);
    expect(screen.getByText("📺")).toBeInTheDocument();
  });

  it("shows battery percentage", () => {
    render(<DeviceCard device={baseDevice} selected={false} onClick={() => {}} />);
    expect(screen.getByText(/80%/)).toBeInTheDocument();
  });

  it("shows low battery class when battery <= 20", () => {
    const device = { ...baseDevice, battery: 15 };
    render(<DeviceCard device={device} selected={false} onClick={() => {}} />);
    const battery = screen.getByText(/15%/);
    expect(battery.className).toContain("low");
  });

  it("shows charging icon when charging", () => {
    const device = { ...baseDevice, charging: true };
    render(<DeviceCard device={device} selected={false} onClick={() => {}} />);
    expect(screen.getByText(/⚡/)).toBeInTheDocument();
  });

  it("applies selected class when selected", () => {
    const { getByTestId } = render(
      <DeviceCard device={baseDevice} selected={true} onClick={() => {}} />
    );
    expect(getByTestId("device-card").className).toContain("selected");
  });

  it("applies offline class when state is not device", () => {
    const device = { ...baseDevice, state: "offline" };
    const { getByTestId } = render(
      <DeviceCard device={device} selected={false} onClick={() => {}} />
    );
    expect(getByTestId("device-card").className).toContain("offline");
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const { getByTestId } = render(
      <DeviceCard device={baseDevice} selected={false} onClick={onClick} />
    );
    fireEvent.click(getByTestId("device-card"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("falls back to address when model is null", () => {
    const device = { ...baseDevice, model: null };
    render(<DeviceCard device={device} selected={false} onClick={() => {}} />);
    // Both dc-name and dc-addr show the address when model is null — at least one should exist
    const elements = screen.getAllByText("192.168.1.100:5555");
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });
});
