# Phase B

The goal of phase B is to further refine the app and add features that were postponed in Phase A.

## Phase B1: Custom player  
So far we have been using mpv to run the movies. There are some problems with this such as the black screen issue and the on screen transperrent chat in the full screen mode which are still buggy/ not working. In this phase we will experiment with building our own player. Specificatios are:
1. It should support all common video formats.
2. Complete and seemless integration with the transfer and sync systems of the coCine. Since the player is specifically designed for cocine, and will only be run within coCine, this is our opportunity to get rid of the wonky and patchy integrations we have with mpv. 
3. Play, pause, and seek operations. Seek forward should be limited to the timestamp of the user who has the least of the movie downloaded. Similar for seek backward in there is a user who has joined midway and therefore does not have an earlier chink of the movie. This also means that the player should be aware of the transfer pipeline (as mentioned in point 2).
4. On screen chat in full screen mode. This has been a problem in mpv since mpv is not designed to support such things. Since we are building our own player, this should no longer be difficult to integrate.
5. Support on windows, mac and linux (including wayland).
6. Subtitle support along with advanced subtitle controls like color, size and position.
7. The fact that we are using 2 windows has also created problems (like the black screen) that we have fixed partially through patchwork. Having the player in the same window should also get rid of these issues. 
7. Suggest any other features that can be implemented without much difficulty here that were difficult/ impossible in mpv.
Note: This will be a large phase. You may divide this into subphases as you want.


## Phase B2: Publiclly accisible server.
Currently one of the users has to run the server and give their IP to others to connect to the server. I would like to avoid this. I want to see if there is a way to host this publiclly and for free. We will need to explore this. But since the load on the server is so low and we can tollerate cold starts, i think we can find a way to do this for free.


## Phase B3: mac support and testing.
We have built support for windows and linux rn. We need to add the same for mac. 


## Phase B4: Network situation simulations.
There are manu network situations that we have technically accounted for but have not tested. Ans might never be able to test due to the lack of devices. I want to simulate these the best we can and test the app on it.