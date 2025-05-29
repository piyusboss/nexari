<?php
// nexari_ai.php

// --- CONFIGURATIONS ---
define('MAX_CHATS_CONFIG', 25);
define('DEFAULT_TTS_ENABLED_CONFIG', true);
define('DEFAULT_TTS_LANGUAGE_CONFIG', 'en-US');

// --- HUGGING FACE INTEGRATION ---

// !!! IMPORTANT !!!
// REPLACE 'YOUR_HUGGING_FACE_API_KEY' WITH YOUR ACTUAL HUGGING FACE KEY.
// KEEP YOUR KEY SECRET AND DO NOT COMMIT IT TO PUBLIC REPOSITORIES.
define('HUGGING_FACE_API_KEY', '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'); // <<<<<<< APNI KEY YAHAN PASTE KAREIN

// You can choose any other text-generation model from Hugging Face Hub.
// Llama 3 is a great general-purpose choice.
define('HUGGING_FACE_MODEL', 'meta-llama/Meta-Llama-3-8B-Instruct');
define('HUGGING_FACE_API_URL', 'https://api-inference.huggingface.co/models/' . HUGGING_FACE_MODEL);


// Standardized messages for Dynamic Island
$dynamic_island_messages_config = [
    'thinking' => 'Nexari is processing...',
    'replied' => 'Nexari has replied.',
    'error_generic' => 'An error occurred on the server.',
    'settings_saved' => 'Settings saved!',
    'chat_deleted' => 'Chat deleted.',
    'all_chats_cleared' => 'All chat history cleared.',
    'new_chat_started' => 'New chat started.'
];

/**
 * Gets a response from the Hugging Face Inference API.
 *
 * @param string $user_message The message from the user.
 * @return string The AI's response or an error message.
 */
function get_ai_bot_response(string $user_message): string {
    $sanitized_message = htmlspecialchars(trim($user_message));

    if (empty($sanitized_message)) {
        return "It seems you didn't say anything.";
    }
    
    // Data payload for the API
    $data = [
        'inputs' => $sanitized_message,
        'parameters' => [
            'max_new_tokens' => 250, // Limit the length of the response
            'temperature' => 0.7,   // Makes the output more creative
            'return_full_text' => false // To avoid getting the input prompt back in the response
        ],
        'options' => [
            'wait_for_model' => true // If the model is not ready, wait for it
        ]
    ];
    $payload = json_encode($data);

    // Prepare HTTP headers
    $headers = [
        'Authorization: Bearer ' . HUGGING_FACE_API_KEY,
        'Content-Type: application/json',
    ];

    // cURL request to Hugging Face API
    $ch = curl_init(HUGGING_FACE_API_URL);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30); // 30-second timeout

    $api_response = curl_exec($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    // Check for cURL errors
    if (curl_errno($ch)) {
        $error_msg = curl_error($ch);
        curl_close($ch);
        error_log("cURL Error: " . $error_msg);
        return "Sorry, I couldn't connect to the AI service. Please try again later. (cURL Error)";
    }
    
    curl_close($ch);

    // Decode the JSON response
    $response_data = json_decode($api_response, true);

    // Handle different HTTP status codes and API responses
    if ($http_code !== 200 || !$response_data) {
        // Check for specific Hugging Face errors
        if (isset($response_data['error'])) {
            error_log("Hugging Face API Error: " . $response_data['error']);
             if (isset($response_data['estimated_time'])) {
                 return "The AI model is currently loading, please try again in a moment. (Est. time: " . round($response_data['estimated_time']) . "s)";
             }
            return "Sorry, there was an API error: " . $response_data['error'];
        }
        error_log("API Error: HTTP Status " . $http_code . " | Response: " . $api_response);
        return "Sorry, I encountered an issue while processing your request. (HTTP Status: {$http_code})";
    }

    // Extract the generated text from the response
    // The response is an array, we get the first element's 'generated_text'
    if (isset($response_data[0]['generated_text'])) {
        return trim($response_data[0]['generated_text']);
    } else {
        error_log("Invalid API response format: " . $api_response);
        return "I received a response, but couldn't understand it. Please try asking differently.";
    }
}


// --- Request Handling ---

// Set default content type. It might be overridden for JSON.
header('Content-Type: text/plain; charset=utf-8');
header('Access-Control-Allow-Origin: *'); // For local testing. Remove or restrict in production.
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

// Handle preflight OPTIONS request for CORS
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}


if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (isset($_GET['action'])) {
        $action = $_GET['action'];

        if ($action === 'ping') {
            echo "pong";
        } elseif ($action === 'get_config') {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode([
                'max_chats' => MAX_CHATS_CONFIG,
                'tts_enabled_default' => DEFAULT_TTS_ENABLED_CONFIG,
                'tts_language_default' => DEFAULT_TTS_LANGUAGE_CONFIG,
                'dynamic_island_messages' => $dynamic_island_messages_config
            ]);
        } else {
            http_response_code(400); // Bad Request
            echo "Error: Invalid action specified for GET request.";
        }
    } else {
        http_response_code(400); // Bad Request
        echo "Error: No action specified for GET request.";
    }
    exit;

} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // This is for the AI chat message
    if (isset($_POST['message'])) {
        $user_message = $_POST['message'];
        
        // The get_ai_bot_response function now calls the Hugging Face API
        $ai_response = get_ai_bot_response($user_message);
        
        echo $ai_response;

    } else {
        http_response_code(400); // Bad Request
        echo "Error: 'message' parameter not provided in POST request.";
    }
    exit;
    
} else {
    http_response_code(405); // Method Not Allowed
    echo "Error: Invalid request method. Only GET and POST are supported.";
    exit;
}
?>
