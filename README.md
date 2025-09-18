# LLM-MS


**LLM Meta Search (LLM-MS)** is a web-based multi-model Large Language Model (LLM) search engine designed to dynamically select and allocate resources across multiple open-source LLMs. Its goal is to provide **accurate, cost-efficient, and diversified responses** by intelligently routing queries to the most suitable models while optimizing token usage.

LLM-MS introduces two **novel model-selection algorithms** that balance **response quality and computational cost**, enabling efficient use of multiple heterogeneous LLMs without retraining or fine-tuning a single giant model.

ChatUcy has been developed by researchers and students at the **Data Management Systems Laboratory (DMSL)**, Department of Computer Science, **University of Cyprus**.

URL: [https://chatucy.cs.ucy.ac.cy/](https://chatucy.cs.ucy.ac.cy/)

Contact: [dzeina@cs.ucy.ac.cy](mailto:dzeina@cs.ucy.ac.cy)

---

## Preface
The explosion of open-source LLMs makes it difficult to identify the best model for a specific task. Training or fine-tuning a single monolithic model is computationally expensive and unsustainable. **LLM-MS** addresses this by **dynamically combining multiple independent LLMs** and allocating tokens to the best-performing ones on a per-query basis.

It introduces two key algorithms:

- **LLM-MS-OUA (Overperformers–Underperformers Algorithm):** Iteratively prunes low-performing models and progressively allocates tokens to the strongest ones for more accurate, cost-effective results.  
- **LLM-MS-MAB (Multi-Armed Bandit Algorithm):** Uses a reinforcement-learning UCB1 strategy to balance exploration and exploitation, dynamically prioritizing the most promising models.

If you publish work using LLM-MS, please cite:

- **"LLM-MS: A Multi-Model LLM Search Engine"**, Konstantin Krasovitskiy, Stelios Christou, Demetrios Zeinalipour-Yazti, Department of Computer Science, University of Cyprus, 2025.

---

We hope you find **LLM-MS** useful for research and innovation.  
Feedback and questions: [dzeina@cs.ucy.ac.cy](mailto:dzeina@cs.ucy.ac.cy).

**Enjoy LLM-MS!**

The LLM-MS Team

---

Copyright (c) 2025, Data Management Systems Lab (DMSL), Department of Computer Science  
University of Cyprus.  
All rights reserved.

---

## GNU General Public License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY**; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  
See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with this program.  
If not, see [https://www.gnu.org/licenses/gpl-3.0.html](https://www.gnu.org/licenses/gpl-3.0.html).

The software is provided “as is”, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.

---

## Components

Short description of the contents in this release:

### Algorithms
Implementation of **LLM-MS-OUA** and **LLM-MS-MAB** for dynamic LLM selection and token allocation.

### Backend (Flask / Apache)
**Flask-based web server** (running under Apache mod_wsgi) integrating with the Ollama daemon for LLM execution.

### Retrieval-Augmented Generation (RAG)
- Uses **ChromaDB vector database** to:
  - Store embeddings of uploaded documents and queries,
  - Retrieve the most relevant context via cosine similarity,
  - Construct enriched prompts for LLM inference.
- RAG improves the quality of responses but operates **independently of the multi-LLM selection mechanism**.

### LLM Filesystem & Daemon
- **Ollama 0.4.5 Daemon:** Loads and executes multiple LLMs and handles inference requests.
- **LLM Filesystem:** Stores and manages the supported LLM models.

### Frontend
Browser-based **interactive UI** that supports:
- Real-time response streaming,
- Dynamic model selection,
- Session history with privacy controls.

### Datasets & Evaluation
Evaluated on the **TruthfulQA benchmark** using models such as **Llama 3.1 8B**, **Mistral 0.3 7B**, and **Qwen2.5 7B**.  
Metrics: **Reward**, **F1-score**, and **Reward-to-Tokens ratio**, showing that LLM-MS algorithms outperform single-model baselines in both efficiency and response quality.

---

Project Supervisor: **Prof. Demetrios Zeinalipour-Yazti**  
Project Leader: **Konstantin Krasovitskiy**
