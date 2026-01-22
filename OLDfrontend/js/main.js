let useModel = null;
let currentSession = "default"; // Default fallback
let manuallySelectedSession = null;
let userHuggingFaceToken = null;

const encoder = window.GPT3Encoder;
function estimateTokenCount(text) {
  if (!encoder || !text) return 0;
  return encoder.encode(text).length;
}

const savedToken = localStorage.getItem("hfToken");
if (savedToken && savedToken.startsWith("hf_")) {
  userHuggingFaceToken = savedToken;
  const input = document.getElementById("hfTokenInput");
  if (input) input.value = savedToken; // Prefill the input box
}

function storeHuggingFaceToken(token) {
  if (token && token.startsWith("hf_")) {
    userHuggingFaceToken = token;
    sessionStorage.setItem("hfToken", token);
    showCustomAlert("✅ Hugging Face token stored.");
  } else {
    showCustomAlert("❌ Invalid Hugging Face token format.");
  }
}

function clearHuggingFaceToken() {
  userHuggingFaceToken = null;
  localStorage.removeItem("hfToken");
  const input = document.getElementById("hfTokenInput");
  if (input) input.value = "";
  showCustomAlert("🔓 Token cleared. You’ll need to re-enter it to continue.");
}

async function getUseModel() {
  if (!useModel) {
    useModel = await use.load();
  }
  return useModel;
}

function splitIntoChunks(text, size, overlap) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    const chunk = text.slice(i, i + size);
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

async function startUpload() {
  const uploadStart = performance.now();
  // console.log("Upload started...");

  const files = document.getElementById("formFile").files;

  if (!files.length) {
    showCustomAlert("Please upload at least one PDF file.");

    return;
  }

  const sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
  // If we're in the default session AND the file exists elsewhere, create a new session
  if (currentSession === "default") {
    const existingChunks = await getAllChunksFromIndexedDB();
    const uploadedNames = new Set(Array.from(files).map((f) => f.name));
    const usedInOtherSessions = existingChunks.some((chunk) =>
      uploadedNames.has(chunk.source)
    );

    if (usedInOtherSessions) {
      createAutomaticSession(); // create new session before storing
    }
  }

  // Ensure a session exists
  if (!sessions.some((s) => s.name === currentSession)) {
    createAutomaticSession(); // fallback if session somehow not listed
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js";
  document.getElementById(
    "status"
  ).innerText = `Processing ${files.length} file(s)...`;

  const allChunks = [];

  const existingNames = new Set(
    Array.from(document.querySelectorAll("#uploadedFilesList span")).map((el) =>
      el.textContent.trim()
    )
  );

  await Array.from(files).reduce((chain, file) => {
    return chain.then(() => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async function () {
          const fileName = file.name;
          if (existingNames.has(fileName)) {
            const confirmReplace = await showCustomConfirm(
              `"${fileName}" already exists. Replace existing embeddings?`
            );
            if (!confirmReplace) return;
          }
          await deleteChunksBySource(fileName);

          // Display in uploaded list if new
          if (!existingNames.has(fileName)) {
            const fileListContainer =
              document.getElementById("uploadedFilesList");
            if (
              fileListContainer.textContent.includes("No files uploaded yet")
            ) {
              fileListContainer.innerHTML = "";
            }

            const div = document.createElement("div");
            div.classList.add(
              "d-flex",
              "justify-content-between",
              "align-items-center",
              "mb-1"
            );

            const nameSpan = document.createElement("span");
            nameSpan.textContent = fileName;
            nameSpan.style.cursor = "pointer";
            nameSpan.onclick = () => showPdfDetails(fileName, div);

            nameSpan.classList.add("flex-grow-1", "text-break");

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "btn btn-sm btn-outline-danger ms-2";
            deleteBtn.innerHTML = "🗑️";
            deleteBtn.title = `Delete '${fileName}'`;
            deleteBtn.onclick = async () => {
              const confirmDelete = await showCustomConfirm(
                `Delete "${fileName}" from storage?`
              );
              if (!confirmDelete) return;

              await deleteChunksBySource(fileName);
              div.remove();

              if (!fileListContainer.querySelector("div")) {
                fileListContainer.innerHTML = `<div class="text-muted">No files uploaded yet</div>`;
              }
            };

            div.appendChild(nameSpan);
            div.appendChild(deleteBtn);
            fileListContainer.appendChild(div);
            existingNames.add(fileName);
          }

          // Time for reading
          const readStart = performance.now();

          // Read PDF contents
          const typedarray = new Uint8Array(this.result);
          try {
            const pdf = await pdfjsLib.getDocument(typedarray).promise;
            let fullText = "";

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
              const page = await pdf.getPage(pageNum);
              const textContent = await page.getTextContent();
              const pageText = textContent.items
                .map((item) => item.str)
                .join(" ");
              fullText += pageText + " ";
            }

            //time for read
            const readEnd = performance.now();
            // console.log(
            //   ` Reading "${fileName}": ${(readEnd - readStart).toFixed(2)} ms`
            // );

            // Dynamically adjust chunk size
            let chunkSize, chunkOverlap;
            const textLength = fullText.length;
            if (textLength < 5000) {
              chunkSize = 500;
              chunkOverlap = 100;
            } else if (textLength < 20000) {
              chunkSize = 1000;
              chunkOverlap = 200;
            } else if (textLength < 50000) {
              chunkSize = 1500;
              chunkOverlap = 300;
            } else {
              chunkSize = 2000;
              chunkOverlap = 500;
            }

            // chunking time
            const chunkStart = performance.now();

            const chunks = splitIntoChunks(fullText, chunkSize, chunkOverlap);
            document.getElementById(
              "status"
            ).innerText = `Embedding ${chunks.length} chunks from ${file.name}...`;
            //chunking time
            const chunkEnd = performance.now();
            // console.log(
            //   ` Splitting "${fileName}": ${(chunkEnd - chunkStart).toFixed(
            //     2
            //   )} ms`
            // );

            const model = await getUseModel();
            const progressBar = document.getElementById("embeddingProgress");
            const embeddings = [];

            // embed time
            const embedStart = performance.now();

            for (let i = 0; i < chunks.length; i++) {
              const tensor = await model.embed([chunks[i]]);
              const embedding = tensor.arraySync()[0];
              embeddings.push({
                chunk: chunks[i],
                embedding: embedding,
                source: fileName,
              });

              const percent = Math.round(((i + 1) / chunks.length) * 100);
              progressBar.style.width = percent + "%";
              progressBar.textContent = `${percent}% (${fileName})`;
            }

            //embed time
            const embedEnd = performance.now();
            // console.log(
            //   ` Embedding "${fileName}": ${(embedEnd - embedStart).toFixed(
            //     2
            //   )} ms`
            // );

            allChunks.push(...embeddings);
            resolve();
          } catch (error) {
            console.error("Error processing", fileName, error);
            resolve();
          }
        };
        reader.readAsArrayBuffer(file);
      });
    });
  }, Promise.resolve());

  // store time
  const storeStart = performance.now();

  // Save all collected chunks into IndexedDB
  await storeChunksInIndexedDB(allChunks);

  //store time
  const storeEnd = performance.now();
  // console.log(` Store : ${(storeEnd - storeStart).toFixed(2)} ms`);

  document.getElementById(
    "status"
  ).innerText = `Embeddings saved for ${files.length} PDF(s).`;
  document.getElementById("embeddingProgress").style.width = "100%";
  document.getElementById("embeddingProgress").textContent = "100%";

  const progressBar = document.getElementById("embeddingProgress");
  progressBar.classList.remove("progress-bar-striped", "progress-bar-animated");
  progressBar.classList.add("bg-success");
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getDBName(), 1);
    request.onupgradeneeded = function (e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("chunks")) {
        db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeChunksInIndexedDB(chunks) {
  const db = await openDB();
  const tx = db.transaction("chunks", "readwrite");
  const store = tx.objectStore("chunks");
  for (const chunk of chunks) {
    await new Promise((res, rej) => {
      const req = store.add(chunk);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }
  await tx.complete;
  db.close();
}

async function populateDropdownFromIndexedDB() {
  const chunks = await getAllChunksFromIndexedDB();
  const fileListContainer = document.getElementById("uploadedFilesList");

  if (!chunks.length) return;

  // Get unique file names
  const fileNames = [...new Set(chunks.map((chunk) => chunk.source))];

  fileListContainer.innerHTML = ""; // Clear existing content

  fileNames.forEach((fileName) => {
    const div = document.createElement("div");
    div.classList.add(
      "d-flex",
      "justify-content-between",
      "align-items-center",
      "mb-1"
    );

    const nameSpan = document.createElement("span");
    nameSpan.textContent = fileName;
    nameSpan.classList.add("flex-grow-1", "text-break");
    nameSpan.style.cursor = "pointer";
    nameSpan.onclick = () => showPdfDetails(fileName, div);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-sm btn-outline-danger ms-2";
    deleteBtn.innerHTML = "🗑️";
    deleteBtn.title = `Delete '${fileName}'`;
    deleteBtn.onclick = async () => {
      const confirmDelete = await showCustomConfirm(
        `Delete "${fileName}" from storage?`
      );
      if (!confirmDelete) return;

      await deleteChunksBySource(fileName);
      div.remove();

      if (!fileListContainer.querySelector("div")) {
        fileListContainer.innerHTML = `<div class="text-muted">No files uploaded yet</div>`;
      }
    };

    div.appendChild(nameSpan);
    div.appendChild(deleteBtn);
    fileListContainer.appendChild(div);
  });
}

function clearIndexedDB() {
  const request = indexedDB.deleteDatabase("pdf_embeddings");
  request.onsuccess = function () {
    showCustomAlert("✅ All embeddings cleared!");
    document.getElementById("status").innerText = "Storage cleared.";
    document.getElementById("embeddingProgress").style.width = "0%";
    document.getElementById("embeddingProgress").textContent = "0%";

    // Clear dropdown list
    const dropdownList = document.getElementById("uploadedFilesDropdownList");
    dropdownList.innerHTML = `
      <li>
        <span class="dropdown-item text-muted">No files uploaded yet</span>
      </li>
    `;

    // Disable dropdown button
    document
      .getElementById("uploadedFilesDropdownBtn")
      .classList.add("disabled");
  };
  request.onerror = function () {
    showCustomAlert("❌ Failed to clear IndexedDB.");
  };
}

async function deleteChunksBySource(fileName) {
  const allChunks = await getAllChunksFromIndexedDB();
  const db = await openDB();
  const tx = db.transaction("chunks", "readwrite");
  const store = tx.objectStore("chunks");

  allChunks.forEach((chunk) => {
    if (chunk.source === fileName) {
      store.delete(chunk.id);
    }
  });

  await tx.done;
  db.close();
}

async function getChunksBySource(fileName) {
  const db = await openDB();
  const tx = db.transaction("chunks", "readonly");
  const store = tx.objectStore("chunks");
  const allChunks = await new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return allChunks.filter((c) => c.source === fileName);
}

async function deleteChunkById(id) {
  const db = await openDB();
  const tx = db.transaction("chunks", "readwrite");
  const store = tx.objectStore("chunks");
  store.delete(id);
  await tx.done;
  db.close();
}

async function clearSessionIndexedDB() {
  const dbName = `pdf_embeddings_${currentSession}`;
  const req = indexedDB.deleteDatabase(dbName);
  req.onsuccess = () => {
    showCustomAlert(`✅ Cleared "${currentSession}" embeddings.`);
    document.getElementById(
      "uploadedFilesList"
    ).innerHTML = `<div class="text-muted">No files uploaded yet</div>`;
    document.getElementById("embeddingProgress").style.width = "0%";
    document.getElementById("embeddingProgress").textContent = "0%";
  };
  req.onerror = () =>
    showCustomAlert(`❌ Failed to clear "${currentSession}" DB.`);
}

async function getAllChunksFromIndexedDB() {
  try {
    const db = await openDB();
    const tx = db.transaction("chunks", "readonly");
    const store = tx.objectStore("chunks");
    const chunks = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return chunks;
  } catch (err) {
    console.warn("Failed to load chunks from IndexedDB:", err);
    return []; // Gracefully handle any other IndexedDB errors
  }
}

async function displayStreamingAnswer(container, html) {
  container.innerHTML = html;
}

async function handleUserQuestion() {
  const input = document.getElementById("userQuestion");
  const question = input.value.trim();
  const chatBox = document.getElementById("chatBox");
  if (!question) return;

  // Hide all preview sections before refreshing them
  document.getElementById("contextPreview").style.display = "none";
  document.getElementById("promptPreview").style.display = "none";
  document.getElementById("chatContextPreview").style.display = "none";

  // Also clear their content (optional for visual refresh)
  document.getElementById("contextList").innerHTML = "";
  document.getElementById("promptList").innerHTML = "";
  document.getElementById("chatContextBox").textContent = "";

  moveSessionToTop(currentSession);

  const sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
  if (!sessions.some((s) => s.name === currentSession)) {
    createAutomaticSession();
  }

  // Show user question
  const userMsg = document.createElement("div");
  userMsg.className = "d-flex justify-content-end mb-2";
  userMsg.innerHTML = `
    <div class="bg-primary text-white rounded px-3 py-2" style="max-width: 75%;">
      <strong>You:</strong><br>${question}
    </div>`;
  chatBox.appendChild(userMsg);
  chatBox.scrollTop = chatBox.scrollHeight;
  saveChatMessage("user", question);
  input.value = "";

  // Typing indicator
  const typingMsg = document.createElement("div");
  typingMsg.className = "d-flex justify-content-start mb-2";
  const bubble = document.createElement("div");
  bubble.style.background = "#e9ecef";
  bubble.style.borderRadius = "20px";
  bubble.style.padding = "10px 15px";
  bubble.style.fontFamily = "monospace";
  bubble.style.fontSize = "16px";
  bubble.style.color = "#555";
  bubble.style.maxWidth = "75%";
  typingMsg.id = "typing-indicator";
  typingMsg.appendChild(bubble);
  chatBox.appendChild(typingMsg);
  chatBox.scrollTop = chatBox.scrollHeight;

  let dotCount = 0;
  bubble.textContent = "PrivateLLM is thinking";
  const interval = setInterval(() => {
    dotCount = (dotCount + 1) % 4;
    bubble.textContent = "PrivateLLM is thinking" + ".".repeat(dotCount);
  }, 400);

  // Load embeddings
  const chunks = await getAllChunksFromIndexedDB();
  const allChunksText = chunks
    .map((c) => c.chunk.trim())
    .filter((chunk) => chunk.length > 20);
  const model = await getUseModel();
  const questionEmbeddingTensor = await model.embed([question]);
  const questionEmbedding = questionEmbeddingTensor.arraySync()[0];

  let topChunks = [],
    topChunksText = [],
    usingContext = chunks.length > 0,
    context = "";

  // Load recent chat history for context preview (not for ChatUCY prompt)
  let recentTurns = "",
    fullHistory = [];
  if (usingContext) {
    const key = `chat_history_${currentSession}`;
    fullHistory = JSON.parse(localStorage.getItem(key) || "[]");
    recentTurns = fullHistory
      .slice(-6)
      .map((m) => `${m.sender === "user" ? "You" : "PrivateLLM"}: ${m.message}`)
      .join("\n");

    const ranked = chunks
      .map((chunkObj) => ({
        chunk: chunkObj.chunk,
        score: cosineSimilarity(questionEmbedding, chunkObj.embedding),
        source: chunkObj.source || "unknown",
      }))
      .sort((a, b) => b.score - a.score);

    const chunkCount =
      parseInt(document.getElementById("chunkCountInput").value) || 5;
    topChunks = ranked.slice(0, chunkCount);
    topChunksText = topChunks.map((c) => c.chunk);

    let chunkContext = topChunksText.join("\n\n");
    let combinedContext = `${recentTurns}\n\n${chunkContext}`;
    let estimatedTokens = estimateTokenCount(combinedContext);

    const MAX_TOKENS = 2000;
    if (estimatedTokens > MAX_TOKENS) {
      recentTurns = fullHistory
        .slice(-4)
        .map(
          (m) => `${m.sender === "user" ? "You" : "PrivateLLM"}: ${m.message}`
        )
        .join("\n");
      combinedContext = `${recentTurns}\n\n${chunkContext}`;
      estimatedTokens = estimateTokenCount(combinedContext);

      while (estimatedTokens > MAX_TOKENS && topChunks.length > 1) {
        topChunks.pop();
        topChunksText = topChunks.map((c) => c.chunk);
        chunkContext = topChunksText.join("\n\n");
        combinedContext = `${recentTurns}\n\n${chunkContext}`;
        estimatedTokens = estimateTokenCount(combinedContext);
      }
    }

    context = combinedContext;

    const contextList = document.getElementById("contextList");
    contextList.innerHTML = "";
    topChunks.forEach((c, i) => {
      const div = document.createElement("div");
      div.classList.add("mb-2", "border", "rounded", "p-2", "bg-light");
      div.innerHTML = `<div><strong>From:</strong> ${
        c.source
      }</div><div><strong>Chunk #${i + 1}:</strong><br>${c.chunk}</div>`;
      contextList.appendChild(div);
    });
    document.getElementById("contextPreview").style.display = "block";
  } else {
    document.getElementById("contextPreview").style.display = "none";
    document.getElementById("chatContextPreview").style.display = "none";
  }

  // K-Anonymity Prompts
  const k = parseInt(document.getElementById("kValueInput").value) || 1;
  const fakeEntries = await generateFakePrompts(k - 1);

  // Build the real question entry (only using your PDF data + noise)
  const realEntry = {
    text: question,
    isReal: true,
    context: await generateNoisyContext(topChunksText, 0.8),
  };

  // Combine them — but make sure fake ones do not leak into real context
  const allPrompts = [
    ...fakeEntries.map((e) => ({
      text: e.question,
      context: e.context,
      isReal: false,
    })),
    realEntry,
  ];

  // Shuffle AFTER everything is clean and separated
  const shuffled = allPrompts.sort(() => Math.random() - 0.5);

  const promptList = document.getElementById("promptList");
  promptList.innerHTML = "";
  shuffled.forEach((entry, i) => {
    const card = document.createElement("div");
    card.classList.add("mb-2", "border", "rounded", "p-2", "bg-light");
    card.innerHTML = `
      <div><strong>Prompt ${i + 1} (${
      entry.isReal ? "REAL" : "FAKE"
    }):</strong></div>
      <div class="mb-2"><code>${entry.text}</code></div>
      <div><strong>Context:</strong></div>
      <pre class="small mb-0" style="white-space: pre-wrap;">${
        entry.context
      }</pre>`;
    promptList.appendChild(card);
  });
  document.getElementById("promptPreview").style.display =
    shuffled.length > 0 ? "block" : "none";

  const isChatUCY = document
    .getElementById("other-tab")
    ?.classList.contains("active");
  let finalAnswer = "";

  try {
    if (isChatUCY) {
      const results = await Promise.all(
        shuffled.map(({ text, context }) => sendToChatUCY(text, context))
      );
      const realIndex = shuffled.findIndex((p) => p.isReal);
      const { cleaned, previewPrompt } = results[realIndex];

      finalAnswer = cleaned;
      clearInterval(interval);
      document.getElementById("typing-indicator")?.remove();
      const botMsg = document.createElement("div");
      botMsg.className = "d-flex justify-content-start mb-2";
      const newBubble = document.createElement("div");
      newBubble.className = "bg-light border rounded px-3 py-2";
      newBubble.style.maxWidth = "75%";
      const responseSpan = document.createElement("span");
      responseSpan.style.fontFamily = "inherit";
      responseSpan.style.fontSize = "inherit";
      responseSpan.style.whiteSpace = "pre-wrap";

      newBubble.innerHTML = `<strong>PrivateLLM:</strong><br>`;
      newBubble.appendChild(responseSpan);
      botMsg.appendChild(newBubble);
      chatBox.appendChild(botMsg);
      await displayStreamingAnswer(responseSpan, marked.parse(cleaned));

      const formatted = previewPrompt
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");

      if (usingContext) {
        const formatted = previewPrompt
          .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
          .join("\n\n");

        document.getElementById("chatContextBox").textContent = formatted;
        document.getElementById("chatContextPreview").style.display = "block";
      } else {
        document.getElementById("chatContextPreview").style.display = "none";
      }
    } else {
      const responses = await Promise.all(
        shuffled.map(({ text, context }) => queryHuggingFaceLLM(context, text))
      );
      finalAnswer = responses[shuffled.findIndex((p) => p.isReal)];
      clearInterval(interval);
      document.getElementById("typing-indicator")?.remove();
      const botMsg = document.createElement("div");
      botMsg.className = "d-flex justify-content-start mb-2";
      const newBubble = document.createElement("div");
      newBubble.className = "bg-light border rounded px-3 py-2";
      newBubble.style.maxWidth = "75%";
      const responseSpan = document.createElement("span");
      responseSpan.style.fontFamily = "inherit";
      responseSpan.style.fontSize = "inherit";
      responseSpan.style.whiteSpace = "pre-wrap";

      newBubble.innerHTML = `<strong>PrivateLLM:</strong><br>`;
      newBubble.appendChild(responseSpan);
      botMsg.appendChild(newBubble);
      chatBox.appendChild(botMsg);
      await displayStreamingAnswer(responseSpan, marked.parse(finalAnswer));
      if (usingContext) {
        document.getElementById("chatContextBox").textContent = context;
        document.getElementById("chatContextPreview").style.display = "block";
      } else {
        document.getElementById("chatContextPreview").style.display = "none";
      }
    }

    saveChatMessage("bot", finalAnswer);
  } catch (err) {
    console.error("LLM error:", err);
    const fallbackBubble = document.createElement("div");
    fallbackBubble.className = "bg-light border rounded px-3 py-2";
    fallbackBubble.style.maxWidth = "75%";
    fallbackBubble.innerHTML = `<strong>PrivateLLM:</strong><br><span style="white-space: pre-wrap;">❌ Failed to get response.</span>`;
    chatBox.appendChild(fallbackBubble);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (magA * magB);
}

async function generateFakePrompts(count) {
  const results = [];
  while (results.length < count) {
    const fake = await fetchFakeWikipediaPrompt();
    if (!results.some((p) => p.question === fake.question)) {
      results.push(fake); // Store both question and context
    }
  }
  return results;
}

async function fetchFakeWikipediaPrompt() {
  try {
    const response = await fetch(
      "https://en.wikipedia.org/api/rest_v1/page/random/summary"
    );
    const data = await response.json();
    const title = data.title;
    const context = data.extract || "No summary available.";
    const question = `What is ${title}?`;
    return { question, context };
  } catch (err) {
    console.error("Wikipedia fetch failed:", err);
    return {
      question: "What is quantum physics?",
      context:
        "Quantum physics is a fundamental branch of physics concerned with processes involving, for example, atoms and photons.",
    };
  }
}

async function generateNoisyContext(realChunks, ratio = 0.8) {
  const fullText = realChunks.join(" ").trim();
  if (!fullText) return "[FALLBACK] No real context available.";

  // Split real context into sentences
  const sentences = fullText
    .split(/(?<=[.?!])\s+/)
    .filter((s) => s.trim().length > 0);

  const totalSentences = sentences.length;
  const numToReplace = Math.floor(totalSentences * (1 - ratio));

  // Fetch noise sentences from Wikipedia
  const noiseSentences = [];
  while (noiseSentences.length < numToReplace) {
    const fake = await fetchFakeWikipediaPrompt();
    const sentence = fake.context
      .split(/(?<=[.?!])\s+/)
      .find((s) => s.length >= 30 && s.length <= 150);

    if (sentence) noiseSentences.push(sentence);
  }

  // Replace random real sentences with noise
  const indices = new Set();
  while (indices.size < numToReplace) {
    indices.add(Math.floor(Math.random() * totalSentences));
  }

  const mixed = sentences.map((s, i) =>
    indices.has(i) ? noiseSentences.pop() : s
  );

  return mixed.join(" ");
}

async function showPdfDetails(fileName, itemElement) {
  const listView = document.getElementById("uploadedFilesList");
  const detailView = document.getElementById("pdfDetailView");
  const detailName = document.getElementById("pdfDetailName");
  const chunksView = document.getElementById("pdfChunksView");

  listView.classList.add("d-none");
  detailView.classList.remove("d-none");

  detailName.textContent = fileName;
  chunksView.innerHTML = "<em>Loading chunks...</em>";

  const chunks = await getChunksBySource(fileName);

  if (!chunks.length) {
    chunksView.innerHTML =
      "<div class='text-muted'>No chunks found for this file.</div>";
    return;
  }

  chunksView.innerHTML = "";
  chunks.forEach((chunkObj, i) => {
    const wrapper = document.createElement("div");
    wrapper.classList.add("position-relative", "mb-2");

    const chunkBox = document.createElement("div");
    chunkBox.classList.add("border", "rounded", "p-3", "bg-white");

    const header = document.createElement("div");
    header.classList.add(
      "d-flex",
      "justify-content-between",
      "align-items-center",
      "mb-2"
    );

    const title = document.createElement("strong");
    title.textContent = `Chunk ${i + 1}`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-sm btn-outline-danger";
    deleteBtn.title = "Delete this chunk";
    deleteBtn.innerHTML = "🗑️";
    deleteBtn.onclick = async () => {
      const confirmDelete = await showCustomConfirm("Delete this chunk?");
      if (!confirmDelete) return;

      await deleteChunkById(chunkObj.id);
      wrapper.remove();

      if (!chunksView.querySelector(".position-relative")) {
        chunksView.innerHTML = `<div class="text-muted">No chunks left in this PDF.</div>`;
      }
    };

    header.appendChild(title);
    header.appendChild(deleteBtn);

    const content = document.createElement("div");
    content.innerHTML = chunkObj.chunk;

    chunkBox.appendChild(header);
    chunkBox.appendChild(content);

    wrapper.appendChild(chunkBox);
    chunksView.appendChild(wrapper);
  });

  // Delete button behavior
  const deleteBtn = document.getElementById("deleteThisPDFBtn");
  deleteBtn.onclick = async () => {
    const confirmDelete = await showCustomConfirm(
      `Delete "${fileName}" from storage?`
    );
    if (!confirmDelete) return;

    await deleteChunksBySource(fileName);
    itemElement.remove();
    backToList();
    if (!listView.querySelector("div")) {
      listView.innerHTML = `<div class="text-muted">No files uploaded yet</div>`;
    }
  };
}

function backToList() {
  document.getElementById("pdfDetailView").classList.add("d-none");
  document.getElementById("uploadedFilesList").classList.remove("d-none");
}
document.getElementById("backToListBtn").onclick = backToList;

document.addEventListener("DOMContentLoaded", () => {
  renderSessionList();

  new Sortable(document.getElementById("favoritesList"), {
    animation: 150,
    onEnd: saveSessionOrder,
  });

  new Sortable(document.getElementById("allSessionsList"), {
    animation: 150,
    onEnd: saveSessionOrder,
  });

  currentSession = null;
  document.getElementById("sessionHeader").textContent = `No active session`;
  document.getElementById("status").innerText = `No active session`;
  backToList();
  const tooltipElements = document.querySelectorAll(
    '[data-bs-toggle="tooltip"]'
  );

  const isTouchDevice =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;

  tooltipElements.forEach((el) => {
    if (isTouchDevice) {
      const tooltip = new bootstrap.Tooltip(el, {
        trigger: "manual",
      });

      let isShown = false;

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isShown) {
          tooltip.hide();
          isShown = false;
        } else {
          tooltip.show();
          isShown = true;
        }
      });

      document.addEventListener("click", (e) => {
        if (isShown && !el.contains(e.target)) {
          tooltip.hide();
          isShown = false;
        }
      });
    } else {
      // Desktop: standard Bootstrap behavior
      new bootstrap.Tooltip(el, {
        trigger: "hover focus",
      });
    }
  });
  // If chatBox is empty, show welcome message
  const chatBox = document.getElementById("chatBox");
  if (chatBox && chatBox.children.length === 0) {
    const introMsg = document.createElement("div");
    introMsg.className = "d-flex justify-content-start mb-2";
    introMsg.innerHTML = `
        <div class="bg-light border rounded px-3 py-2" style="max-width: 75%;">
          <strong>PrivateLLM:</strong><br>
          Welcome! 👋<br>
          You can upload one or more PDF files, and then ask questions about their content.<br>
          I'll use an AI model to find and answer based on what’s inside your documents.
        </div>`;
    chatBox.appendChild(introMsg);
  }
});

function toggleSidebar() {
  const sidebar = document.getElementById("leftSidebar");
  const wrapper = document.getElementById("mainWrapper");
  const overlay = document.getElementById("overlay");

  const isMobile = window.innerWidth < 768;
  const isOpen = sidebar.style.transform === "translateX(0px)";

  const closeBtn = document.getElementById("closeSidebarBtn");

  if (isOpen) {
    if (isMobile) {
      sidebar.style.transform = "translateX(-100%)";
      overlay.style.display = "none";
      closeBtn.style.display = "none"; // Hide close button
    } else {
      sidebar.style.transform = "translateX(-250px)";
      wrapper.style.marginLeft = "0";
      closeBtn.style.display = "none"; //  Hide close button
    }
  } else {
    if (isMobile) {
      sidebar.style.width = "100%";
      sidebar.style.transform = "translateX(0px)";
      overlay.style.display = "block";
      overlay.onclick = toggleSidebar;
      closeBtn.style.display = "block"; // Show close button on mobile
    } else {
      sidebar.style.width = "250px";
      sidebar.style.transform = "translateX(0px)";
      wrapper.style.marginLeft = "250px";
      closeBtn.style.display = "none"; // Hide close button
    }
  }
}

function getDBName() {
  return `pdf_embeddings_${currentSession}`;
}

function createSession() {
  let name = document.getElementById("newSessionInput").value.trim();
  let sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");

  if (!name) {
    let nextNumber = 1;
    while (sessions.some((s) => s.name === `Session ${nextNumber}`)) {
      nextNumber++;
    }
    name = `Session ${nextNumber}`;
  }

  if (!sessions.some((s) => s.name === name)) {
    sessions.unshift({ name: name, favorite: false });
    localStorage.setItem("sessionList", JSON.stringify(sessions));
    renderSessionList();
  }

  switchSession(name);
  document.getElementById("newSessionInput").value = "";
}

function createAutomaticSession() {
  let sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
  let nextNumber = 1;
  while (sessions.some((s) => s.name === `Session ${nextNumber}`)) {
    nextNumber++;
  }
  const newName = `Session ${nextNumber}`;

  sessions.unshift({ name: newName, favorite: false });
  localStorage.setItem("sessionList", JSON.stringify(sessions));
  renderSessionList();
  switchSession(newName);
}

function switchSession(name) {
  document.getElementById("contextList").innerHTML = "";
  document.getElementById("promptList").innerHTML = "";
  document.getElementById("chatContextBox").textContent = "";
  document.getElementById("contextPreview").style.display = "none";
  document.getElementById("promptPreview").style.display = "none";
  document.getElementById("chatContextPreview").style.display = "none";
  manuallySelectedSession = name;
  currentSession = name;
  localStorage.setItem("lastSession", name);

  const header = document.getElementById("sessionHeader");
  if (name) {
    header.textContent = `Session: ${name}`;
  } else {
    header.textContent = `No active session`;
  }

  document.getElementById("status").innerText = `Session: ${name || "None"}`;
  const progressBar = document.getElementById("embeddingProgress");
  progressBar.style.width = "0%";
  progressBar.textContent = "";
  progressBar.classList.remove("bg-success");
  progressBar.classList.add("progress-bar-striped", "progress-bar-animated");
  document.getElementById(
    "uploadedFilesList"
  ).innerHTML = `<div class="text-muted">No files uploaded yet</div>`;
  document.getElementById("contextList").innerHTML = "";
  document.getElementById("contextPreview").style.display = "none";
  document.getElementById(
    "activeSessionDisplay"
  ).textContent = `Active: ${name}`;

  populateDropdownFromIndexedDB();
  loadChatHistory();
  renderSessionList(); //  Re-render to update pink highlight
}

function saveSessionOrder() {
  const allSpans = [
    ...document
      .getElementById("favoritesList")
      .querySelectorAll("li span:nth-child(2)"),
    ...document
      .getElementById("allSessionsList")
      .querySelectorAll("li span:nth-child(2)"),
  ];

  let sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");

  const updated = allSpans.map((span) => {
    const name = span.textContent.trim();
    const match = sessions.find((s) => s.name === name);
    return match || { name, favorite: false };
  });

  localStorage.setItem("sessionList", JSON.stringify(updated));
}

function saveChatMessage(sender, message) {
  const key = `chat_history_${currentSession}`;
  const history = JSON.parse(localStorage.getItem(key) || "[]");

  history.push({ sender, message });
  localStorage.setItem(key, JSON.stringify(history));
}

function loadChatHistory() {
  const key = `chat_history_${currentSession}`;
  const history = JSON.parse(localStorage.getItem(key) || "[]");
  const chatBox = document.getElementById("chatBox");
  chatBox.innerHTML = "";

  // Re-show intro
  const introMsg = document.createElement("div");
  introMsg.className = "d-flex justify-content-start mb-2";
  introMsg.innerHTML = `
    <div class="bg-light border rounded px-3 py-2" style="max-width: 75%;">
      <strong>PrivateLLM:</strong><br>
      Welcome! 👋<br>
      You can upload one or more PDF files, and then ask questions about their content.<br>
      I'll use an AI model to find and answer based on what’s inside your documents.
    </div>`;
  chatBox.appendChild(introMsg);

  // Restore messages
  history.forEach(({ sender, message }) => {
    const msg = document.createElement("div");
    msg.className = `d-flex justify-content-${
      sender === "user" ? "end" : "start"
    } mb-2`;
    const parsedMessage = sender === "user" ? message : marked.parse(message);

    msg.innerHTML = `
  <div class="${
    sender === "user" ? "bg-primary text-white" : "bg-light border"
  } rounded px-3 py-2" style="max-width: 75%;">
    <strong>${sender === "user" ? "You" : "PrivateLLM"}:</strong><br>
    ${parsedMessage}
  </div>`;
    chatBox.appendChild(msg);
  });

  chatBox.scrollTop = chatBox.scrollHeight;
}

function renderSessionList() {
  const sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");

  const favoritesListUI = document.getElementById("favoritesList");
  const allSessionsListUI = document.getElementById("allSessionsList");
  const favoritesCard = document.getElementById("favoritesCard");

  favoritesListUI.innerHTML = "";
  allSessionsListUI.innerHTML = "";

  const favorites = sessions.filter((s) => s.favorite);
  const others = sessions.filter((s) => !s.favorite);

  // Hide or show the Favorites section
  if (favorites.length === 0) {
    favoritesCard.style.display = "none"; // Hide if no favorites
  } else {
    favoritesCard.style.display = "flex"; // Show if there are favorites
  }

  function renderSession(session, listUI) {
    const li = document.createElement("li");
    li.className =
      "list-group-item d-flex justify-content-between align-items-center";

    li.onclick = () => switchSession(session.name);

    li.onmouseenter = () => {
      if (session.name !== manuallySelectedSession) {
        li.style.backgroundColor = "#f0f0f0";
      }
    };
    li.onmouseleave = () => {
      if (session.name === manuallySelectedSession) {
        li.style.backgroundColor = "#ffc5d3";
      } else {
        li.style.backgroundColor = "";
      }
    };

    if (session.name === manuallySelectedSession) {
      li.style.backgroundColor = "#ffc5d3";
      li.style.fontWeight = "bold";
    }

    const starBtn = document.createElement("span");
    starBtn.innerHTML = session.favorite ? "⭐" : "☆";
    starBtn.style.cursor = "pointer";
    starBtn.style.marginRight = "5px";
    starBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(session.name);
    };

    const nameSpan = document.createElement("span");
    nameSpan.textContent = session.name;
    nameSpan.style.overflow = "hidden";
    nameSpan.style.textOverflow = "ellipsis";
    nameSpan.style.whiteSpace = "nowrap";
    nameSpan.style.maxWidth = "120px";

    const buttonGroup = document.createElement("div");
    buttonGroup.className = "d-flex gap-1";

    const renameBtn = document.createElement("button");
    renameBtn.className = "btn btn-sm btn-outline-secondary";
    renameBtn.innerHTML = "✏️";
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      startInlineRename(nameSpan, session.name);
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-sm btn-outline-danger";
    deleteBtn.innerHTML = "🗑️";
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteSession(session.name);
    };

    buttonGroup.appendChild(renameBtn);
    buttonGroup.appendChild(deleteBtn);

    li.appendChild(starBtn);
    li.appendChild(nameSpan);
    li.appendChild(buttonGroup);

    listUI.appendChild(li);
  }

  favorites.forEach((session) => renderSession(session, favoritesListUI));
  others.forEach((session) => renderSession(session, allSessionsListUI));
}

function moveSessionToTop(name) {
  if (!name) return;

  let sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
  sessions = sessions.filter((s) => s.name !== name);
  const sessionObj = sessions.find((s) => s.name === name) || {
    name,
    favorite: false,
  };
  sessions.unshift(sessionObj);
  localStorage.setItem("sessionList", JSON.stringify(sessions));

  renderSessionList();
}

async function deleteSession(name) {
  const confirmDelete = await showCustomConfirm(
    `Are you sure you want to delete the session "${name}"? This will remove all related files and chat.`
  );
  if (!confirmDelete) return;

  // Remove chat
  localStorage.removeItem(`chat_history_${name}`);

  // Remove IndexedDB
  const deleteRequest = indexedDB.deleteDatabase(`pdf_embeddings_${name}`);
  deleteRequest.onsuccess = () =>
    // console.log(`IndexedDB for session "${name}" deleted.`);
    (deleteRequest.onerror = () =>
      console.error(`Failed to delete DB for session "${name}"`));

  // Remove from session list
  let sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
  sessions = sessions.filter((s) => s.name !== name);
  localStorage.setItem("sessionList", JSON.stringify(sessions));

  // If currently active session is deleted, switch to another or default
  if (currentSession === name) {
    location.reload();
  }

  renderSessionList();
}

function startInlineRename(nameSpan, oldName) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = oldName;
  input.className = "form-control form-control-sm";
  input.style.maxWidth = "120px";

  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;

  async function finishRename(cancel = false) {
    if (finished) return;
    finished = true;

    if (cancel) {
      input.replaceWith(nameSpan); // Restore old name
      return;
    }

    const newName = input.value.trim();
    if (!newName) {
      input.replaceWith(nameSpan);
      return;
    }

    let sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
    const existingNames = sessions
      .map((s) => s.name)
      .filter((s) => s !== oldName);

    if (existingNames.includes(newName)) {
      showCustomAlert("A session with this name already exists.");
      input.replaceWith(nameSpan);
      return;
    }

    // Update session list
    sessions = sessions.map((s) =>
      s.name === oldName ? { ...s, name: newName } : s
    );
    localStorage.setItem("sessionList", JSON.stringify(sessions));

    // Rename chat history key
    const oldChatKey = `chat_history_${oldName}`;
    const newChatKey = `chat_history_${newName}`;
    const chatHistory = localStorage.getItem(oldChatKey);
    if (chatHistory) {
      localStorage.setItem(newChatKey, chatHistory);
      localStorage.removeItem(oldChatKey);
    }

    // Rename IndexedDB database
    const oldDBName = `pdf_embeddings_${oldName}`;
    const newDBName = `pdf_embeddings_${newName}`;

    const oldRequest = indexedDB.open(oldDBName);
    oldRequest.onsuccess = () => {
      const oldDB = oldRequest.result;
      const tx = oldDB.transaction("chunks", "readonly");
      const store = tx.objectStore("chunks");
      const getAllReq = store.getAll();

      getAllReq.onsuccess = () => {
        const chunks = getAllReq.result;
        oldDB.close();

        // Delete old DB and create new one
        const deleteReq = indexedDB.deleteDatabase(oldDBName);
        deleteReq.onsuccess = () => {
          const newRequest = indexedDB.open(newDBName, 1);
          newRequest.onupgradeneeded = (e) => {
            e.target.result.createObjectStore("chunks", {
              keyPath: "id",
              autoIncrement: true,
            });
          };
          newRequest.onsuccess = () => {
            const newDB = newRequest.result;
            const tx = newDB.transaction("chunks", "readwrite");
            const newStore = tx.objectStore("chunks");
            chunks.forEach((chunk) => newStore.add(chunk));
            tx.oncomplete = () => newDB.close();
          };
        };
      };
    };

    // Update active session
    if (currentSession === oldName) {
      currentSession = newName;
      localStorage.setItem("lastSession", newName);
      document.getElementById(
        "sessionHeader"
      ).textContent = `Session: ${newName}`;
      document.getElementById(
        "activeSessionDisplay"
      ).textContent = `Active: ${newName}`;
    }

    renderSessionList();
  }

  input.addEventListener("blur", () => finishRename());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      finishRename();
    } else if (e.key === "Escape") {
      finishRename(true); // cancel cleanly
    }
  });
}

function showCustomAlert(message) {
  const modalBody = document.getElementById("customAlertModalBody");
  modalBody.textContent = message;

  const modalElement = document.getElementById("customAlertModal");
  const modal = new bootstrap.Modal(modalElement);

  modal.show();

  function keyHandler(e) {
    if (e.key === "Enter" || e.key === "Escape") {
      modal.hide();
    }
  }

  modalElement.addEventListener("keydown", keyHandler);

  modalElement.addEventListener("hidden.bs.modal", () => {
    modalElement.removeEventListener("keydown", keyHandler);
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modalBody = document.getElementById("customConfirmModalBody");
    const okButton = document.getElementById("customConfirmOkBtn");
    const cancelButton = document.getElementById("customConfirmCancelBtn");
    const modalElement = document.getElementById("customConfirmModal");
    const modal = new bootstrap.Modal(modalElement);

    modalBody.textContent = message;

    function cleanup() {
      okButton.removeEventListener("click", onOk);
      cancelButton.removeEventListener("click", onCancel);
      modalElement.removeEventListener("keydown", keyHandler);
    }

    function onOk() {
      cleanup();
      resolve(true);
      modal.hide();
    }

    function onCancel() {
      cleanup();
      resolve(false);
      modal.hide();
    }

    function keyHandler(e) {
      if (e.key === "ArrowLeft") {
        cancelButton.focus();
      } else if (e.key === "ArrowRight") {
        okButton.focus();
      } else if (e.key === "Enter") {
        if (document.activeElement === okButton) {
          onOk();
        } else if (document.activeElement === cancelButton) {
          onCancel();
        }
      }
    }

    okButton.addEventListener("click", onOk);
    cancelButton.addEventListener("click", onCancel);
    modalElement.addEventListener("keydown", keyHandler);

    modal.show();
  });
}

document.getElementById("sessionSearchInput").addEventListener("input", () => {
  const query = document
    .getElementById("sessionSearchInput")
    .value.trim()
    .toLowerCase();
  filterSessions(query);
});

function filterSessions(query) {
  const sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
  const sessionListUI = document.getElementById("allSessionsList");
  sessionListUI.innerHTML = "";

  const filtered = sessions.filter((session) => {
    const lowerName = session.name.toLowerCase();
    const chatKey = `chat_history_${session.name}`;
    const chatHistory = JSON.parse(localStorage.getItem(chatKey) || "[]");
    const chatMatches = chatHistory.some(
      (m) => m.message && m.message.toLowerCase().includes(query)
    );
    return lowerName.includes(query) || chatMatches;
  });

  const favorites = filtered.filter((s) => s.favorite);
  const others = filtered.filter((s) => !s.favorite);

  function renderSection(title, list) {
    if (list.length === 0) return;
    const header = document.createElement("div");
    header.className = "text-muted small mb-1 mt-2";
    header.textContent = title;
    sessionListUI.appendChild(header);

    list.forEach((session) => {
      const li = document.createElement("li");
      li.className =
        "list-group-item d-flex justify-content-between align-items-center";
      li.style.cursor = "pointer";
      li.style.transition = "background-color 0.3s ease";

      if (session.name === manuallySelectedSession) {
        li.style.backgroundColor = "#ffc5d3";
        li.style.fontWeight = "bold";
      }

      li.onclick = () => switchSession(session.name);

      li.onmouseenter = () => {
        if (session.name !== manuallySelectedSession) {
          li.style.backgroundColor = "#f0f0f0";
        }
      };
      li.onmouseleave = () => {
        if (session.name === manuallySelectedSession) {
          li.style.backgroundColor = "#ffc5d3";
        } else {
          li.style.backgroundColor = "";
        }
      };

      const starBtn = document.createElement("span");
      starBtn.innerHTML = session.favorite ? "⭐" : "☆";
      starBtn.style.cursor = "pointer";
      starBtn.style.marginRight = "5px";
      starBtn.onclick = (e) => {
        e.stopPropagation();
        toggleFavorite(session.name);
      };

      const nameSpan = document.createElement("span");
      nameSpan.textContent = session.name;
      nameSpan.style.overflow = "hidden";
      nameSpan.style.textOverflow = "ellipsis";
      nameSpan.style.whiteSpace = "nowrap";
      nameSpan.style.maxWidth = "120px";

      const buttonGroup = document.createElement("div");
      buttonGroup.className = "d-flex gap-1";

      const renameBtn = document.createElement("button");
      renameBtn.className = "btn btn-sm btn-outline-secondary";
      renameBtn.innerHTML = "✏️";
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        startInlineRename(nameSpan, session.name);
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn btn-sm btn-outline-danger";
      deleteBtn.innerHTML = "🗑️";
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        deleteSession(session.name);
      };

      buttonGroup.appendChild(renameBtn);
      buttonGroup.appendChild(deleteBtn);

      li.appendChild(starBtn);
      li.appendChild(nameSpan);
      li.appendChild(buttonGroup);
      sessionListUI.appendChild(li);
    });
  }

  if (favorites.length > 0) renderSection("⭐ Favorites", favorites);
  if (others.length > 0) renderSection("📁 All Sessions", others);
}

function toggleFavorite(name) {
  let sessions = JSON.parse(localStorage.getItem("sessionList") || "[]");
  sessions = sessions.map((s) =>
    s.name === name ? { ...s, favorite: !s.favorite } : s
  );
  localStorage.setItem("sessionList", JSON.stringify(sessions));
  renderSessionList();
}

function convertHistoryForChatUCY(sessionName) {
  const key = `chat_history_${sessionName}`;
  const localHistory = JSON.parse(localStorage.getItem(key) || "[]");

  const converted = localHistory.map((entry) => ({
    role: entry.sender === "user" ? "user" : "assistant",
    content: entry.message,
  }));

  return converted;
}

function appendMessageToChat(sender, message) {
  const chatBox = document.getElementById("chatBox");

  const msg = document.createElement("div");
  msg.className = `d-flex justify-content-${
    sender === "user" ? "end" : "start"
  } mb-2`;
  msg.innerHTML = `
    <div class="${
      sender === "user" ? "bg-primary text-white" : "bg-light border"
    } rounded px-3 py-2" style="max-width: 75%;">
      <strong>${
        sender === "user" ? "You" : "PrivateLLM"
      }:</strong><br>${message}
    </div>`;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function sendToChatUCY(question, context = "") {
  const chatHistory = convertHistoryForChatUCY(currentSession);
  const messages = [];

  messages.push(...chatHistory); // 1. Previous conversation

  if (context && context.trim()) {
    messages.push({
      role: "system",
      content: `Based on the following context, answer the user's next question.\n\n${context}`,
    }); // 2. System prompt with context
  }

  messages.push({ role: "user", content: question }); // 3. Actual question

  const selectedModel =
    document.getElementById("chatucyModelSelect")?.value || "llama3.1";

  const body = {
    model: selectedModel + ":latest",
    messages: messages,
    websearch: false,
    clientSideRag: false,
  };

  const response = await fetch(
    "https://chatucy.cs.ucy.ac.cy/api/send_message",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );

  if (!response.ok) {
    throw new Error(`ChatUCY error: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let responseText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    responseText += chunk;
  }

  const cleaned = responseText
    .replace(/^🌟 Success:\s*/i, "")
    .replace(/This response.*?interaction\./is, "")
    .trim();

  return { cleaned, previewPrompt: messages };
}

async function queryHuggingFaceLLM(context, question) {
  if (!question || typeof question !== "string") {
    console.warn("⚠️ Skipping empty or invalid question.");
    return "⚠️ Invalid question input.";
  }

  let tokenToUse;
  if (userHuggingFaceToken) {
    tokenToUse = userHuggingFaceToken;
  } else {
    showCustomAlert("❌ Please enter your Hugging Face token to continue.");
    return "❌ Token required.";
  }

  // Build prompt making it clear to answer in the user's language
  let prompt;
  if (context) {
    prompt = `Answer the following question based ONLY on the context below.
You MUST always answer in exactly the SAME language as the input question.

Context:
${context}

Question: ${question}
Answer:`;
  } else {
    prompt = `Answer the following question.
You MUST always answer in exactly the SAME language as the input question.

Question: ${question}
Answer:`;
  }

  const selectedModel =
    document.getElementById("hfModelSelect")?.value ||
    "mistralai/Mistral-7B-Instruct-v0.3";

  const response = await fetch(
    `https://api-inference.huggingface.co/models/${selectedModel}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenToUse}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 750,
          temperature: 0.7,
        },
      }),
    }
  );

  // Handle common errors
  if (response.status === 402) {
    showCustomAlert(
      "❌ Your Hugging Face token has expired or hit its usage limit."
    );
    return "❌ Token error: Please check your Hugging Face account.";
  } else if (!response.ok) {
    const errorText = await response.text();
    console.error("Hugging Face API error:", response.status, errorText);
    showCustomAlert("❌ Error communicating with Hugging Face API.");
    return `❌ Error ${response.status}: ${errorText}`;
  }

  const data = await response.json();

  const generated = data?.[0]?.generated_text || "";
  const answerOnly = generated.split("Answer:").pop().trim();

  return answerOnly;
}
