import os
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.ticker import LogLocator, FuncFormatter

# ============================================================
# Output config
# ============================================================
export_dir = "exported_png"
os.makedirs(export_dir, exist_ok=True)

DPI = 600
EXPORT_FORMAT = "png"

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman"],
    "axes.edgecolor": "black",
    "axes.labelcolor": "black",
    "xtick.color": "black",
    "ytick.color": "black",
    "text.color": "black",
})

# ============================================================
# Data from LaTeX table
# ============================================================
models = [
    "llama3.1",
    "qwen2.5",
    "mistral",
    "LLM-MS OUA",
    "LLM-MS MAB",
]

avg_ratio = [
    0.0198,
    0.0226,
    0.0195,
    0.0233,
    0.0225,
]

avg_reward = [
    0.7283,
    0.7438,
    0.7409,
    0.7616,
    0.7728,
]

avg_f1 = [
    0.1119,
    0.1378,
    0.1299,
    0.1636,
    0.1618,
]

# ============================================================
# Plot helper (log scale + 1–2–5 ticks)
# ============================================================
def save_bar_plot(values, ylabel, title, filename):
    fig, ax = plt.subplots(figsize=(8, 4))

    bars = ax.bar(
        models,
        values,
        color="white",
        edgecolor="black"
    )

    # Hatching
    patterns = ['/', '\\', 'x', 'o', '.', '-', '//']
    patterns = (patterns * ((len(models) // len(patterns)) + 1))[:len(models)]
    for bar, pattern in zip(bars, patterns):
        bar.set_hatch(pattern)

    # --- Log scale ---
    ax.set_yscale("log")

    ax.yaxis.set_major_locator(
        LogLocator(base=10.0, subs=(1.0, 2.0, 5.0))
    )

    def log_fmt(x, pos):
        if x <= 0:
            return ""
        if x < 1:
            return f"{x:.3f}".rstrip("0").rstrip(".")
        return f"{x:.2f}".rstrip("0").rstrip(".")

    ax.yaxis.set_major_formatter(FuncFormatter(log_fmt))
    ax.yaxis.set_minor_locator(plt.NullLocator())

    # Labels & style
    ax.set_ylabel(ylabel, fontsize=11)
    ax.set_title(title, fontsize=13, pad=10)
    ax.set_xticklabels(models, rotation=30, ha="right")
    ax.grid(axis="y", linestyle="--", alpha=0.6)

    plt.tight_layout()
    fig.savefig(
        os.path.join(export_dir, f"{filename}.{EXPORT_FORMAT}"),
        dpi=DPI
    )
    plt.close(fig)

# ============================================================
# Generate plots
# ============================================================
save_bar_plot(
    avg_f1,
    "Average F1 Score",
    "Average F1 Score per Model",
    "algorithms_av_f1"
)

save_bar_plot(
    avg_reward,
    "Average Reward",
    "Average Reward per Model",
    "algorithms_avg_reward"
)

save_bar_plot(
    avg_ratio,
    "Average Reward / Token Ratio",
    "Average Reward / Token Ratio per Model",
    "algorithms_avg_ratio"
)

print("All summary plots generated successfully.")
