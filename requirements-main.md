# coCine

A co-streaming app.
coCine is a movie co-watching app that allows you to stream movies with friends with no buffering, minimal latency and voice and text chat features.

## Functional requirements
### Video Streaming
1. One user creates a room which other people can join using a password. The user who created the room is the host.
2. One of the user shares local files- the movie and subs.
3. The users then co-watch the movie. The movie and subs should be in sync for all users.
4. All users or users to whom the host has granted permission may pause/ play the movie at any point. Once the user pauses the movie, it should pause for all users and should start in sync for all users once resumed. 


### Chat Feature
1. Allow all participants in a room to talk to each-other through voice call or chat.
2. Control features such as muting, deafening yourself. 
3. Room owners should have additional controls such as muting/ deafening others.


### UI
1. There should be a simple and elegant UI that allows for the room creating, video streaming, and chat features.
2. For streaming, embed a ope source video player like VLC in the app.
3. Support iOS, windows and linux.


## Non-Functional Requrements
1. Minimal latency in video streaming- This is the key focus of the app. Strategies for this may be as follows, and need to be refined further:
    - A: pre-load: download the movie partially on all devices so ensure minimal buffering minimal latency between users.
    - Point A makes the app's function more to sync pre-downloaded movies that to stream simultaneously.
    - With point A, we can think of the streaming and sync almost like 2 different pipelines, since download will always be ahead of the stream timestamp.
    - B: For P2P connections, optimize the download and upload strategies based on the interet speeds and download states of the users- all users can act as seed and leech simultaneously.
    - Explore download strategies based on interet speed for both P2P and server based rooms.
2. All app functions achieved through a P2P connection or through a AWS server- whichever the user (owner of the room) chooses.
3. Scalable structure. While the room size is always expected to be small (usually 2-10, rarely exceeding 25), the overall all should be scalable to having multiple rooms running simultaneously.


NOTE: this is the rough structure of the requrements. THis needs to be refined further.