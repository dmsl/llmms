use wasm_bindgen::prelude::*;
use js_sys::{Array, Float32Array};
use serde::{Serialize, Deserialize};

// Data structures for our RAG system
#[derive(Serialize, Deserialize)]
pub struct Chunk {
    pub id: String,
    pub content: String,
    pub document_id: String,
    pub chunk_number: u32,
    pub session_id: String,
}

// Main RAG processor for vector operations
#[wasm_bindgen]
pub struct RagProcessor {
    chunk_size: u32,
    chunk_overlap: u32,
}

#[wasm_bindgen]
impl RagProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(chunk_size: u32, chunk_overlap: u32) -> Self {
        console_log("Initializing RagProcessor");
        Self {
            chunk_size,
            chunk_overlap,
        }
    }
    
    // Split text into chunks
    #[wasm_bindgen]
    pub fn text_to_chunks(&self, text: String, document_id: String, session_id: String) -> JsValue {
        let paragraphs: Vec<&str> = text.split("\n\n").collect();
        let mut chunks = Vec::new();
        let mut current_chunk = String::new();
        let mut chunk_number = 0;
        
        for paragraph in paragraphs {
            if !current_chunk.is_empty() && 
               (current_chunk.len() + paragraph.len() > self.chunk_size as usize) {
                // Save current chunk
                chunks.push(Chunk {
                    id: self.generate_id(),
                    content: current_chunk.clone(),
                    document_id: document_id.clone(),
                    chunk_number,
                    session_id: session_id.clone(),
                });
                
                chunk_number += 1;
                
                // Create overlap for next chunk
                let words: Vec<&str> = current_chunk.split_whitespace().collect();
                let overlap_word_count = (self.chunk_overlap as f32 / 5.0).ceil() as usize;
                let overlap_word_count = std::cmp::min(overlap_word_count, words.len());
                
                if overlap_word_count > 0 {
                    current_chunk = words[words.len() - overlap_word_count..].join(" ");
                } else {
                    current_chunk = String::new();
                }
            }
            
            if !current_chunk.is_empty() {
                current_chunk.push_str("\n\n");
            }
            current_chunk.push_str(paragraph);
        }
        
        // Add the final chunk if not empty
        if !current_chunk.trim().is_empty() {
            chunks.push(Chunk {
                id: self.generate_id(),
                content: current_chunk,
                document_id,
                chunk_number,
                session_id,
            });
        }
        
        // Convert to JS array
        match serde_wasm_bindgen::to_value(&chunks) {
            Ok(js_chunks) => js_chunks,
            Err(_) => JsValue::NULL,
        }
    }
    
    // Generate a mock embedding vector
    #[wasm_bindgen]
    pub fn generate_mock_embedding(&self, text: String) -> Float32Array {
        let dim = 384; // Standard embedding dimension
        let mut vector = vec![0.0; dim];
        
        // Simple deterministic hash-based embedding
        for (i, c) in text.chars().enumerate() {
            let idx = i % dim;
            vector[idx] += (c as u32 % 255) as f32 / 255.0;
        }
        
        // Normalize the vector
        let magnitude: f32 = vector.iter().map(|&v| v * v).sum::<f32>().sqrt();
        
        if magnitude > 0.0 {
            for v in &mut vector {
                *v /= magnitude;
            }
        }
        
        // Convert to Float32Array
        let result = Float32Array::new_with_length(vector.len() as u32);
        for (i, &val) in vector.iter().enumerate() {
            result.set_index(i as u32, val);
        }
        
        result
    }
    
    // Cosine similarity between two vectors
    #[wasm_bindgen]
    pub fn cosine_similarity(&self, vec_a: Float32Array, vec_b: Float32Array) -> f32 {
        let mut dot_product = 0.0;
        let mut norm_a = 0.0;
        let mut norm_b = 0.0;
        
        let len = std::cmp::min(vec_a.length(), vec_b.length());
        
        for i in 0..len {
            let a = vec_a.get_index(i);
            let b = vec_b.get_index(i);
            dot_product += a * b;
            norm_a += a * a;
            norm_b += b * b;
        }
        
        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }
        
        dot_product / (norm_a.sqrt() * norm_b.sqrt())
    }
    
    // Find most similar chunks from a set
    #[wasm_bindgen]
    pub fn find_similar_chunks(&self, query_embedding: Float32Array, chunks_with_embeddings: JsValue, top_k: u32) -> JsValue {
        // Parse the input chunks with embeddings
        let chunks_data: Vec<(Chunk, Vec<f32>)> = match serde_wasm_bindgen::from_value(chunks_with_embeddings) {
            Ok(data) => data,
            Err(_) => return JsValue::from_str("Error parsing chunks data"),
        };
        
        if chunks_data.is_empty() {
            return Array::new().into();
        }
        
        // Convert query_embedding to Vec<f32> for easier use
        let query_vec: Vec<f32> = (0..query_embedding.length())
            .map(|i| query_embedding.get_index(i))
            .collect();
        
        // Calculate similarity scores
        let mut chunk_scores: Vec<(&Chunk, f32)> = Vec::new();
        for (chunk, embedding) in &chunks_data {
            let score = self.vector_similarity(&query_vec, embedding);
            chunk_scores.push((chunk, score));
        }
        
        // Sort by score (highest first) and take top_k
        chunk_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_chunks: Vec<&Chunk> = chunk_scores.iter()
            .take(top_k as usize)
            .map(|(chunk, _)| *chunk)
            .collect();
        
        // Convert to JS array
        match serde_wasm_bindgen::to_value(&top_chunks) {
            Ok(result) => result,
            Err(_) => JsValue::from_str("Error serializing results"),
        }
    }
    
    // Vector similarity (internal helper)
    fn vector_similarity(&self, vec_a: &[f32], vec_b: &[f32]) -> f32 {
        let mut dot_product = 0.0;
        let mut norm_a = 0.0;
        let mut norm_b = 0.0;
        
        let len = std::cmp::min(vec_a.len(), vec_b.len());
        
        for i in 0..len {
            dot_product += vec_a[i] * vec_b[i];
            norm_a += vec_a[i] * vec_a[i];
            norm_b += vec_b[i] * vec_b[i];
        }
        
        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }
        
        dot_product / (norm_a.sqrt() * norm_b.sqrt())
    }
    
    // Generate a random ID (simple implementation)
    fn generate_id(&self) -> String {
        let mut id = String::new();
        for _ in 0..16 {
            let random_byte = (js_sys::Math::random() * 16.0) as u8;
            id.push_str(&format!("{:x}", random_byte));
        }
        id
    }
}

// Helper function for console logging
fn console_log(msg: &str) {
    web_sys::console::log_1(&JsValue::from_str(msg));
}

// Initialize panic hook
#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}
