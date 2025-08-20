
import sys
import os
from faster_whisper import WhisperModel
import logging

# --- Logging Setup ---
# Configure logging to output to stderr
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)

def transcribe_audio(audio_path):
    """
    Transcribes an audio file using the faster-whisper model.
    """
    try:
        # --- Model Configuration ---
        # Get model name and directory from environment variables
        model_name = os.environ.get('WHISPER_MODEL_NAME', 'large-v3')
        model_dir = os.environ.get('WHISPER_MODELS_DIR', '/app/models')
        
        model_path = os.path.join(model_dir, f"faster-whisper-{model_name}")

        logging.info(f"Loading model: {model_name} from path: {model_path}")
        
        if not os.path.exists(model_path):
            logging.error(f"Model directory not found at {model_path}")
            logging.error("Please ensure the model was downloaded during the Docker build process.")
            raise FileNotFoundError(f"Model not found at {model_path}")

        # Load the model
        model = WhisperModel(model_path, device="cpu", compute_type="int8")

        logging.info(f"Starting transcription for: {audio_path}")

        # Transcribe the audio file
        segments, info = model.transcribe(audio_path, beam_size=5, language="zh")

        logging.info(f"Detected language '{info.language}' with probability {info.language_probability}")
        logging.info(f"Transcription duration: {info.duration}s")

        # --- Output Transcription ---
        # Concatenate segments and print the full transcript to stdout
        full_transcript = "".join(segment.text for segment in segments)
        print(full_transcript.strip())
        
        logging.info("Transcription completed successfully.")

    except Exception as e:
        logging.error(f"An error occurred during transcription: {e}", exc_info=True)
        # Print error to stderr so Node.js can capture it
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <path_to_audio_file>", file=sys.stderr)
        sys.exit(1)
    
    audio_file_path = sys.argv[1]
    transcribe_audio(audio_file_path)
