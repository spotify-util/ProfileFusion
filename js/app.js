import { credentials } from "./credentials.js";
import { CustomLocalStorage } from "../../spotify-util/js/customLocalStorage.js";

const CURRENT_VERSION = "0.0.1";    //REINSTATE SETTIMEOUT

var customLocalStorage = new CustomLocalStorage('profilefusion');
var spotify_credentials = null;
var CURRENTLY_RUNNING = false;
var database;
var user_cache = {};
var similar_artists;

const callSpotify = function (url, data) {
    if(!spotify_credentials) return new Promise((resolve, reject) => reject("no spotify_credentials"));
    return $.ajax(url, {
        dataType: 'json',
        data: data,
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token
        },
        beforeSend:function(jQxhr){
          jQxhr.url=url;
        }
    });
}

function postSpotify(url, json) {
    if(!spotify_credentials) return new Promise((resolve, reject) => reject("no spotify_credentials"));
    return $.ajax(url, {
        type: "POST",
        data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token,
            'Content-Type': 'application/json'
        },
    });
}

function deleteSpotify(url) {
    if(!spotify_credentials) return new Promise((resolve, reject) => reject("no spotify_credentials"));
    return $.ajax(url, {
        type: "DELETE",
        //data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token,
            'Content-Type': 'application/json'
        },
    });
}

/**
 * Shuffles an array and does not modify the original.
 * @param {array} array - An array to shuffle.
 * @return {array} A shuffled array.
 */
 const shuffleArray = function (array) {
    //modified from https://javascript.info/task/shuffle
    let tmpArray = [...array];
    for (let i = tmpArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1)); // random RESPONSE_INDEX from 0 to i

        // swap elements tmpArray[i] and tmpArray[j]
        // we use "destructuring assignment" syntax to achieve that
        // you'll find more details about that syntax in later chapters
        // same can be written as:
        // let t = tmpArray[i]; tmpArray[i] = tmpArray[j]; tmpArray[j] = t
        [tmpArray[i], tmpArray[j]] = [tmpArray[j], tmpArray[i]];
    }
    return tmpArray;
}

const resolvePromiseArray = function (promise_array, callback) {
    Promise.all(promise_array).then((results) => callback(false, results)).catch((err) => {
        console.log(`error found in resolvePromiseArray: `, err);
        callback(true, err);
        //removing ^ that should stop the TypeError: finished_api_calls.forEach is not a function
    });
}

const okToRecursivelyFix = function (error_obj) {
    //determine if an error object is an api rate issue that can be fixed by calling it again,
    //or an error on our end (such as syntax) that can't be fixed by recalling the api
    console.log("checking if err is ok to recursively fix", error_obj);
    if (error_obj.status >= 429) return true;
    else {
        console.log("err NOT ok to recursively fix", error_obj);
        return false
    };
}

const loginWithSpotify = function () {
    if (document.location.hostname == 'localhost')
        credentials.spotify.redirect_uri = 'http://localhost:8888/index.html';

    let url = 'https://accounts.spotify.com/authorize?client_id=' + credentials.spotify.client_id +
        '&response_type=token' +
        '&scope=' + encodeURIComponent(credentials.spotify.scopes) +
        '&redirect_uri=' + encodeURIComponent(credentials.spotify.redirect_uri);

    //redirect the page to spotify's login page. after login user comes back to our page with a token in
    //page hash, or, if they're already logged in, a token in customLocalStorage's spotify_credentials
    document.location = url;
}

const loadApp = function () {
    $("#user1").val(`https://open.spotify.com/user/${spotify_credentials.uid}`).trigger("input");
    $("#user2").trigger("input");
    $("#login-page").addClass("hidden");
    $("#main-page").removeClass("hidden");
    setTimeout(function(){
        //make them an offer they can't refuse
        //confirm('You need to refresh the page before proceeding') ? location.reload() : location.reload();
    }, (spotify_credentials.expires - getTime()) * 1000);
}

const getTime = function () {
    return Math.round(new Date().getTime() / 1000);
}

/**
 * Scales a given number in one domain to an equivelent number in a target other domain
 * @param {Number} n - Number to be scaled
 * @param {Number} given_min - Lower limit of n's domain
 * @param {Number} given_max - Upper limit of n's domain
 * @param {Number} target_min - Lower limit of new domain
 * @param {Number} target_max  - Upper limit of new domain
 * @returns {Number} A number scaled to the target new domain
 */
function scaleNumber(n, given_min, given_max, target_min, target_max) {
    let given_range = given_max - given_min,
    target_range = target_max - target_min;
    return ((n - given_min) * target_range / given_range) + target_min;
}

const progress_bar = new ProgressBar.Line('#progress-bar', {
    color: '#1DB954',
    duration: 300,
    easing: 'easeOut',
    strokeWidth: 2,
    step: (state, bar) => bar.path.setAttribute('stroke', state.color) //this is purely so we can change to red on error, otherwise step would be unencessary
});

var pb = { min_val:0, max_val:0.5 };   //current min & max val for the progressbar
function progressBarHandler({current_operation, total_operations, stage = 1, ...junk} = {}) {
    //the idea is that each api call we make results in the progress bar updating
    //we need to get the total number of calls that will be made
    //let total_operations = total_tracks + Math.ceil(total_tracks / 20) + Math.ceil(total_tracks / 100);
                            //+ recursive_operations.missing_tracks + recursive_operations.get_album_calls;
    //^ see the algorithm used in estimateTimeTotal
    if(stage === 'error') {
        progress_bar.animate(progress_bar.value(), {from:{color:'#e31c0e'}, to:{color:'#e31c0e'}});    //red
        $("#estimated-time-remaining p").text('Error');
        return;
    }
    if(stage === "done") {
        progress_bar.animate(1, {from:{color:'#1DB954'}, to:{color:'#1DB954'}});
        $("#estimated-time-remaining p").text("Done!");
        return;
    }
    if(stage === "final") {
        progress_bar.animate(0.95, {from:{color:'#1DB954'}, to:{color:'#1DB954'}});
        $("#estimated-time-remaining p").text("Finishing up...");
        return;
    }
    if(pb.max_val >= 1) pb.max_val = 0.9;

    let animate_value = 0;

    let stage_text = {
        1:() => !!junk.uid ?
            `Getting playlists for ${user_cache[junk.uid].display_name}...` :
            `Getting playlists...`,
        2:() => !!junk.playlist_name ? 
            `Retrieving songs from playlist ${junk.playlist_name}...` : 
            `Retrieving playlist songs...`,
        3:() => !!junk.uid ? 
            `Getting song data for ${user_cache[junk.uid].display_name}'s library...` : 
            `Getting song data...`,
        4:() => !!junk.uid ? 
            `Getting artists for ${user_cache[junk.uid].display_name}...` : 
            `Getting artists...`,
    },
    total_stages = Object.keys(stage_text).length;

    //console.log(`stage: ${stage}, value: ${current_operation}/${total_operations}`);

    const [min_stage_val, max_stage_val] = [(stage - 1) / total_stages, stage / total_stages];
    const [min_pb_val, max_pb_val] = [scaleNumber(min_stage_val, 0, 1, pb.min_val, pb.max_val), scaleNumber(max_stage_val, 0, 1, pb.min_val, pb.max_val)];
    //scale it to be within the stage limit, then scale it to reflect the overall pb domain we're limited to (pb.min_val, pb.max_val)
    animate_value = scaleNumber(current_operation, 0, total_operations, min_pb_val, max_pb_val);
    //console.log(animate_value);

    if(animate_value < progress_bar.value()) animate_value = progress_bar.value();  //prevent the progressbar from ever going backwards
    if(animate_value > 1) animate_value = 1;    //prevent the progressbar from performing weird visuals
    progress_bar.animate(animate_value, {from:{color:'#1DB954'}, to:{color:'#1DB954'}});

    $("#estimated-time-remaining p").text(stage_text[stage]());
}

//taken from https://stackoverflow.com/a/7343013
function round(value, precision) {
    var multiplier = Math.pow(10, precision || 0);
    return Math.round(value * multiplier) / multiplier;
}

const performAuthDance = function () {
    spotify_credentials = customLocalStorage.getItem('spotify_credentials');
    
    // if we already have a token and it hasn't expired, use it,
    if (spotify_credentials?.expires > getTime()) {
        console.log("found unexpired token!");
        location.hash = ''; //clear the hash just in case (this can be removed later)
        //load our app
        loadApp();
    } else {
        // we have a token as a hash parameter in the url
        // so parse hash
        var hash = location.hash.replace(/#/g, '');
        var all = hash.split('&');
        var args = {};
        all.forEach(function (keyvalue) {
            let idx = keyvalue.indexOf('=');
            let key = keyvalue.substring(0, idx);
            let val = keyvalue.substring(idx + 1);
            args[key] = val;
        });
        if (typeof (args['access_token']) != 'undefined') {
            console.log("found a token in url");
            let g_access_token = args['access_token'];
            let expiresAt = getTime() + 3600 - 300 /*5 min grace so that token doesnt expire while program is running*/;
            if (typeof (args['expires_in']) != 'undefined') {
                let expires = parseInt(args['expires_in']);
                expiresAt = expires + getTime() - 300;
            }
            spotify_credentials = {
                token: g_access_token,
                expires: expiresAt
            }
            callSpotify('https://api.spotify.com/v1/me').then((user) => {
                    spotify_credentials.uid = user.id;
                    customLocalStorage.setItem("spotify_credentials", spotify_credentials);
                    location.hash = '';
                    //load app
                    loadApp();
                }, (e) => {
                    //prompt user to login again
                    location.hash = ''; //reset hash in url
                    console.log(e.responseJSON.error);
                    alert("Can't get user info");
                }
            );
        } else {
            // otherwise, have user login
            console.log("user needs to login!");
        }
    }
}

const checkInput = function (input) {
    if(input === "") return true; 
    //checks user input to ensure it contains a user id 
    input = input.toString().trim();   //remove whitespace
    if((input.startsWith('http') && input.includes('open.spotify.com') && input.includes('/user/')) ||
       (input.startsWith('open.spotify.com') && input.includes('/user/')) ||
        input.startsWith('spotify:user:')) return true;
    return false;
};

const getId = function getIdFromUserInput(input) {
    //function assumes input passed the checkInput function
    input = input.toString().trim();
    let id = undefined; //default to undefined for error handling
    //if we have a url
    if(input.startsWith('http') || input.includes('open.spotify.com')) id = input.split('/').pop().split('?')[0];
    //if we have a uri
    else if(input.startsWith('spotify:user:')) id = input.split(':').pop(); //even though .pop() is somewhat inefficent, its less practical to get the length of the array and use that as our index
    return id;
};

const getUserPlaylists = function (uid = '') {
    //retrieves the playlists of the currently logged in user and checks them against
    //global options. stores the hrefs of playlist track list in a global array

    let playlist_objects = [];

    const recursivelyGetAllPlaylists = function (url) {
        return new Promise((resolve, reject) => {
            callSpotify(url).then(async (res) => {
                res.items.forEach((playlist, index) => {
                    if(playlist.owner.id == uid && 
                        playlist.public &&
                        playlist.tracks.total > 0 &&    //remove playlists without any songs, this causes too many complications later in the code to justify including them
                        playlist.tracks.total <= 5000) playlist_objects.push(playlist);
                    progressBarHandler({current_operation:index + res.offset + 1, total_operations:res.total, stage:1, uid:uid});
                });
                
                //if we have more playlists to get...
                if(res.next) await recursivelyGetAllPlaylists(res.next);
                //await should wait until all promises complete
                resolve(playlist_objects);
            }).catch(err => {
                console.log("error in getUserPlaylists... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyGetAllPlaylists(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    //the recursive function returns a promise
    return recursivelyGetAllPlaylists(`https://api.spotify.com/v1/users/${uid}/playlists?limit=50`);
}

/**
 * Retrieves all tracks from a playlist and adds them to a global array. Ignores local files
 * 
 * @param {string} playlist_id - The ID of the playlist to retrieve tracks from
 * @return {promise} - A promise that resolves with an array of tracks (only uris and explicitness) from the requested playlist
 */
const getAllPlaylistTracks = function (playlist_id) {
    let options = {
        //fields:"next,items.track(uri,id,explicit,is_local,name,artists)",
        market:"from_token",
        limit:100
    }, playlist_songs = [];
    
    function recursivelyRetrieveAllPlaylistTracks(url, options = {}) {
        return new Promise((resolve, reject) => {
            callSpotify(url, options).then(async res => {
                //go thru all tracks in this api res and push them to array
                for(const item of res.items) {
                    let track = item["track"];
                    //found a rare, undocumented case of the track object sometimes returning null, specifically when calling the endpoint for this playlist: 6BbewZJ0Cv6V9XSXyyDBSm
                    //there's also podcasts, so the track has to be of a specific type
                    if(!!track && !track.is_local && track.type == 'track') playlist_songs.push(item);
                    else console.log("Item returned false: ", item);
                }
                //if there's more songs in the playlist, call ourselves again, otherwise resolve
                if(!res.next) {
                    resolve({playlist_songs:playlist_songs, playlist_id:playlist_id});  //resolve an object that will be handeled in our .then() catcher
                } else await recursivelyRetrieveAllPlaylistTracks(res.next).then(res=>resolve(res)).catch(err=>reject(err));    //evidently this then/catch is necessary to get the promise to return something
            }).catch(err => {
                console.log("error in getAllPlaylistTracks... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyRetrieveAllPlaylistTracks(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    return recursivelyRetrieveAllPlaylistTracks(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks`, options);
}

const getPlaylistTracks = async function (playlist_id = '') {
    //returns an array of all the tracks from a single, given playlist
    try {
        return await getAllPlaylistTracks(playlist_id).then((res_obj) => res_obj.playlist_songs);
    } catch (err) {
        throw err;
    }
}

const getMultipleAudioFeatures = function ({track_ids=[], array_index=0} = {}) {
    //returns array of spotify full album objects

    var url = "https://api.spotify.com/v1/audio-features/";
    return callSpotify(url, {
        ids: track_ids.join(",")
    }).then(res => {
        return { audio_features:res.audio_features, arr_idx:array_index };
    }).catch(err => {
        console.log("err in getMultipleAudioFeatures... will attempt to recursively fix", err);
        if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                setTimeout(() => resolve(getMultipleAudioFeatures(track_ids)), 500); //wait half a second before calling api again
            }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
            .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
        else return err; //do something for handling errors and displaying it to the user
    });
}

const getAudioFeatures = async function (uid = '') {
    //assumes user is in the cache

    const user_tracks = Object.values(user_cache[uid].tracks);
    let id_array = [];
    //request batches of 20 tracks
    for (let i = 0; i < user_tracks.length; i++) { //for every element in user_tracks
        if (i % 100 == 0) { //this is ok to work when i=0. see below for comments and hopefully you can figure out the logic
            id_array.push([]); //if we've filled one subarray with 100 tracks, create a new subarray
        }
        id_array[id_array.length - 1].push(user_tracks[i].id); //go to the last subarray and add the artist id
        //repeat until we've gone thru every artist in user_tracks
    }

    let pending_getFeaturesCalls = [];   //initialize a promise array
    return new Promise((resolve, reject) => {
        let id_batch_index = 0,
            current_id_batch,
            stagger_api_calls = setInterval(() => {
                current_id_batch = id_array[id_batch_index];
                if (id_batch_index >= id_array.length) { //once we've reached the end of the id_array
                    //console.log("stopping API batch calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_getFeaturesCalls, (err, finished_api_calls) => {
                        //console.log(err, finished_api_calls);
                        if (err) reject(finished_api_calls); //finished_api_calls acts as the err msg

                        let feature_array = [];
                        for(const feature_batch of finished_api_calls) {
                            if (!feature_batch) continue;
                            
                            feature_array.push(...feature_batch);
                        }
                        
                        //console.log("resolving getUserArtists promise");
                        resolve(feature_array);
                    });
                }
                //if we still have more tracks to add:
                pending_getFeaturesCalls.push(getMultipleAudioFeatures({ track_ids:current_id_batch, array_index:id_batch_index }).then(resObj => {; //no .catch() after getMultipleArtists b/c we want the error to appear in the callback, causing a reject to send to our main() function
                    progressBarHandler({ current_operation:resObj.arr_idx+1, total_operations:id_array.length, stage:3, uid:uid });
                    return resObj.audio_features;
                }));
                id_batch_index++;
            }, 125);
    });
}

const getMultipleArtists = function ({artist_ids=[], array_index=0} = {}) {
    //returns array of spotify full album objects
    let url = "https://api.spotify.com/v1/artists/";
    return callSpotify(url, {
        ids: artist_ids.join(",")
    }).then(res => {
        return { artists:res.artists, arr_idx:array_index };
    }).catch(err => {
        console.log("err in getMultipleArtists... will attempt to recursively fix", err);
        if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                setTimeout(() => resolve(getMultipleArtists(artist_ids)), 500); //wait half a second before calling api again
            }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
            .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
        else return err; //do something for handling errors and displaying it to the user
    });
}

const getUserArtists = function(uid='') {
    //assumes user is in the cache
    const user_artists = Object.values(user_cache[uid].artists);
    let id_array = [];
    //request batches of 20 artists
    for (let i = 0; i < user_artists.length; i++) { //for every element in user_artists
        if (i % 20 == 0) { //this is ok to work when i=0. see below for comments and hopefully you can figure out the logic
            id_array.push([]); //if we've filled one subarray with 20 artists, create a new subarray
        }
        id_array[id_array.length - 1].push(user_artists[i].id); //go to the last subarray and add the artist id
        //repeat until we've gone thru every artist in user_artists
    }

    let pending_getArtistsCalls = [];   //initialize a promise array
    return new Promise((resolve, reject) => {
        let id_batch_index = 0,
            current_id_batch,
            stagger_api_calls = setInterval(() => {
                current_id_batch = id_array[id_batch_index];
                if (id_batch_index >= id_array.length) { //once we've reached the end of the id_array
                    //console.log("stopping API batch calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_getArtistsCalls, (err, finished_api_calls) => {
                        //console.log(err, finished_api_calls);
                        if (err) reject(finished_api_calls); //finished_api_calls acts as the err msg

                        let artist_array = [];
                        for(const artist_batch of finished_api_calls) {
                            if (!artist_batch) continue;
                            
                            artist_array.push(...artist_batch);
                        }
                        
                        //console.log("resolving getUserArtists promise");
                        resolve(artist_array);
                    });
                }
                //if we still have more tracks to add:
                pending_getArtistsCalls.push(getMultipleArtists({ artist_ids:current_id_batch, array_index:id_batch_index }).then(resObj => {; //no .catch() after getMultipleArtists b/c we want the error to appear in the callback, causing a reject to send to our main() function
                    progressBarHandler({ current_operation:resObj.arr_idx+1, total_operations:id_array.length, stage:4, uid:uid });
                    return resObj.artists;
                }));
                id_batch_index++;
            }, 125);
    });
}


const sortTrackAppearances = function sortTrackAppearanceCount(track_appearance_object = {}) {
    let appearance_array = Object.entries(track_appearance_object);
    appearance_array.sort((a,b) => b[1] - a[1]);
    let final_obj = {};
    for(const subarray of appearance_array) final_obj[subarray[0]] = subarray[1];
    return final_obj;
}

const validateUserCache = function (uid = '') {
    if(!user_cache[uid]) return false;  //cache is non-existent
    //cache is not fully initialized
    if( !user_cache[uid].hasOwnProperty("display_name") || 
        !user_cache[uid].hasOwnProperty("playlists") ||
        !user_cache[uid].hasOwnProperty("tracks") ||
        !user_cache[uid].hasOwnProperty("artists"))  return false;
    //cache has missing values
    if(Object.keys(user_cache[uid].playlists).length < 1 ||
        Object.keys(user_cache[uid].tracks).length < 1 ||
        Object.keys(user_cache[uid].artists).length < 1) return false;
    return true;
}

const retrieveUserData = async function (uid = 'ollog10') {
    try {
        if(!validateUserCache(uid)) user_cache[uid] = { ...user_cache[uid], playlists: {}, tracks: {}, artists: {}, genres: {} };  //initialize object
        else return; //do something if the user is already in the cache
        const playlist_objects = await getUserPlaylists(uid);   //returns array
        if(playlist_objects.length < 6) return alert(`${user_cache[uid].display_name} does not have enough playlists for the program to work properly`);
        user_cache[uid].playlists = Object.assign({}, ...(playlist_objects.map(playlist => ({ [playlist.id]: playlist }))));

        /*
            so, this is complicated lol. let me take some time to explain it.
            Obj.entries takes {key:val, key:val} and turns it into [[key, val], [key,val]]
            according to my MDN reference, this method is faster than for-in, because .entries() doesn't enumerate prototype properties.
            my assumption is that this results in Obj.entries() being more efficent.
            i'm also under the impression that this is fast than forEach, otherwise I would probably be using that.
            so i convert the user_cache[uid].playlists object into an iterable array with the aforementioned form,
            and i could just stop there, but i need the index of which playlist i'm currently accessing in order to
            properly update the progressbar. to get the index, i have to call .entries() on the resulting array,
            then destructure it. finally, i'll have access to the index, playlist id, and playlist object, 
            allowing me to call all the functions i need.
        */
        const playlists_ids_and_objects = Object.entries(user_cache[uid].playlists);
        for(const [idx, [playlist_id, playlist_obj]] of playlists_ids_and_objects.entries())  {
            progressBarHandler({current_operation:idx+1, total_operations:playlists_ids_and_objects.length, stage:2, playlist_name:playlist_obj.name});
            user_cache[uid].playlists[playlist_id] = { ...playlist_obj, items: await getPlaylistTracks(playlist_id) };
            if(user_cache[uid].playlists[playlist_id].items.length < 1) delete user_cache[uid].playlists[playlist_id];
            //OH NO HE JUST USED 'delete' REEEEEE
            //chill out. I'm skeptical too, but after doing some research, i've determined the 'delete' keyword to
            //be the best option in this particular case. I need to be able to remove that playlist and still iterate
            //over the playlists object as well as its subproperties without errors.
        }

        let tracks = [];
        for(const playlist_obj of Object.values(user_cache[uid].playlists)) 
            for(const item of playlist_obj.items)
                tracks.push(item.track);
                //tracks.push(...playlist_obj.items);
        for (const track of tracks) {
            user_cache[uid].tracks.hasOwnProperty(track.id) ?
                user_cache[uid].tracks[track.id].occurrences++ :
                user_cache[uid].tracks[track.id] = { ...track, occurrences:1 };

            //track_appearance_count.hasOwnProperty(track.id) ? track_appearance_count[track.id]++ : track_appearance_count[track.id] = 1;    //increase track count
            //artists will be an array of artists
            for(const artist of track.artists)
                user_cache[uid].artists.hasOwnProperty(artist.id) ?
                    user_cache[uid].artists[artist.id].occurrences++ :
                    user_cache[uid].artists[artist.id] = { ...artist, occurrences:1 };
                //artist_appearance_count.hasOwnProperty(artist.id) ? artist_appearance_count[artist.id]++ : artist_appearance_count[artist.id] = 1;    //increase artist count
        }

        let audio_features_array = await getAudioFeatures(uid);
        for(const feature_obj of audio_features_array) {   //overwrite each feature object
            if(!feature_obj) continue;   //apparently it's possible for spotify to return null for some feature objects
            if(feature_obj.type != 'audio_features') continue;   //validate type
            user_cache[uid].tracks[feature_obj.id] = { ...user_cache[uid].tracks[feature_obj.id], ...feature_obj };
        }

        let artist_obj_array = await getUserArtists(uid);   //returns array
        for(const artist_obj of artist_obj_array) {   //overwrite each artist object
            if(!artist_obj) continue;   //apparently it's possible for spotify to return null for some artist objects
            if(artist_obj.type != 'artist') continue;   //also podcasts are a thing, so we're going to ignore those
            user_cache[uid].artists[artist_obj.id] = { ...user_cache[uid].artists[artist_obj.id], ...artist_obj };
        }
    } catch (err) {
        console.log(`ERROR in try-catch block: ${err}`);
    } finally {
        console.log(`Finished retrieving data for ${user_cache[uid].display_name}`);
        return;
    }
}

const getTopArtistsHTML = function (uid = '') {
    let sorted = Object.values(user_cache[uid].artists).sort((a, b) => (b.occurrences - a.occurrences)),
        comparing_themself = uid == spotify_credentials.uid,
        new_html = '';
    for(let i=0, artist=sorted.shift(); i < 5; i++, artist=sorted.shift()) {
        new_html += `${i+1}. <a href="${artist.uri}"><b>${artist.name}</b></a>, with <b>${artist.occurrences}</b> occurrences, making up ${round((artist.occurrences/Object.values(user_cache[uid].tracks).reduce((acc, obj) => acc + obj.occurrences, 0)) * 100, 1)}% of ${comparing_themself ? 'your' : 'their'} total tracks`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getTopTracksHTML = function (uid = '') {
    let sorted = Object.values(user_cache[uid].tracks).sort((a, b) => (b.occurrences - a.occurrences)),
        comparing_themself = uid == spotify_credentials.uid,
        new_html = '';
    for(let i=0, track=sorted.shift(); i < 5; i++, track=sorted.shift()) {
        new_html += `${i+1}. <a href="${track.uri}" title="by ${track.artists[0].name}"><b>${track.name}</b></a>, with <b>${track.occurrences}</b> occurrences, making up ${round((track.occurrences/Object.values(user_cache[uid].tracks).reduce((acc, obj) => acc + obj.occurrences, 0)) * 100, 1)}% of ${comparing_themself ? 'your' : 'their'} total tracks`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getTopGenresHTML = function (uid = '') {
    let sorted = Object.values(user_cache[uid].genres).sort((a, b) => (b.occurrences - a.occurrences)),
        comparing_themself = uid == spotify_credentials.uid,
        new_html = '';
    for(let i=0, genre=sorted.shift(); i < 5; i++, genre=sorted.shift()) {
        new_html += `${i+1}. <b>${genre.name[0].toUpperCase() + genre.name.slice(1)}</b>, with <b>${genre.occurrences}</b> occurrences, making up ${round((genre.occurrences/Object.values(user_cache[uid].genres).reduce((acc, obj) => acc + obj.occurrences, 0)) * 100, 1)}% of ${comparing_themself ? 'your' : 'their'} total genres`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getRecentSongs = function(uid = '') {
    //i had to get a bit creative with this algorithm. what i do is sort the playlists in
    //descending order by newest song added, then take the top 5 songs of the top 5 playlists
    //and stick those in a temp array. before i stick them in, i inject a key into the item object
    //with the value of the playlist id, because this isn't included by default; it's meant to be
    //assumed based off of the context of the item (playlist, album, etc).
    //I also ensure that there are no duplicates in that array, for UI purposes.
    //I then sort that array by newest song descending, and extract the top 5 songs. i can easily
    //reference which playlist they were taken from thanks to the ID I manually injected.
    let tmp_arr = [];
    let sorted_playlist_arr = Object.values(user_cache[uid].playlists).sort((a,b) => new Date(b.items.sort((c,d) => new Date(d.added_at) - new Date(c.added_at))[0].added_at) - new Date(a.items.sort((c,d) => new Date(d.added_at) - new Date(c.added_at))[0].added_at));
    for(let i=0, current_playlist=sorted_playlist_arr[i], songs_added=0; i < 5; current_playlist=sorted_playlist_arr[++i], songs_added=0) 
        for(const current_item of current_playlist.items) {
            if(songs_added >= 5) break; //if we've added 5 songs from this playlist, move to the next one
            if(!current_item || current_item.added_by.id != uid) continue;  //error catching
            if(tmp_arr.some(item => item.track.id == current_item.track.id)) continue;  //if track already exists in collected recent songs, move to the next one
            tmp_arr.push({...current_item, playlist_id:current_playlist.id});   //add the track as well as the playlist id for future reference
            songs_added++;  //increment variable to be checked at beginning of loop
        }
    tmp_arr.sort((a,b) => new Date(b.added_at) - new Date(a.added_at));
    return tmp_arr;
}

var dotw = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const getRecentSongsHTML = function({uid='', recent_songs = []} = {}) {
    const getDate = function getDateTextSpecificallyForRecentSongs(date = '') {
        //say only day of week if it happened within the past week
        //exclude year if it happened this year
        let dateToCheck = new Date(date);
        
        const today = new Date();
        const yesterday = new Date(today);
        const oneDayBeforeYesterday = new Date(yesterday);
        const twoDayBeforeYesterday = new Date(yesterday);
        const threeDayBeforeYesterday = new Date(yesterday);
        const fourDayBeforeYesterday = new Date(yesterday);
        const fiveDayBeforeYesterday = new Date(yesterday);

        yesterday.setDate(yesterday.getDate() - 1);
        oneDayBeforeYesterday.setDate(yesterday.getDate() - 1);
        twoDayBeforeYesterday.setDate(yesterday.getDate() - 2);
        threeDayBeforeYesterday.setDate(yesterday.getDate() - 3);
        fourDayBeforeYesterday.setDate(yesterday.getDate() - 4);
        fiveDayBeforeYesterday.setDate(yesterday.getDate() - 5);

        if (dateToCheck.toDateString() === today.toDateString()) {
            return 'earlier today';
        } else if (dateToCheck.toDateString() === yesterday.toDateString()) {
            return 'yesterday';
        } else if (dateToCheck.toDateString() === oneDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === twoDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === threeDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === fourDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === fiveDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if(dateToCheck.getFullYear() == today.getFullYear()) {   //check years
            return `on ${months[dateToCheck.getMonth()]} ${dateToCheck.getDate()}`;
        } else return `on ${dateToCheck.getMonth() + 1}-${dateToCheck.getDate()}-${dateToCheck.getFullYear()}`;
    }
    let new_html = '';
    for(let i=0, item=recent_songs.shift(); i < 5; i++, item=recent_songs.shift()) {
        new_html += `Added <a href="${item.track.uri}" target="_blank">"<b>${item.track.name}"</b></a> 
        by <a href="${item.track.artists[0].uri}" target="_blank">${item.track.artists[0].name}</a> 
        to <a href="${user_cache[uid].playlists[item.playlist_id].uri}" target="_blank">${user_cache[uid].playlists[item.playlist_id].name}</a> 
        ${getDate(new Date(item.added_at))}`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getNewestCreatedPlaylist = function (uid = '') {
    //since spotify doesn't store when playlists were created, i had to make my own algorithm to try and deduce this
    //system flow: sort each playlist using the oldest added song as the discriminator, then look at which of those songs
    //is the newest to determine what is likely their most recently created playlist
    return Object.values(user_cache[uid].playlists).sort((a,b) => new Date(b.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at) - new Date(a.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at))[0];
}

const getOldestCreatedPlaylist = function (uid = '') {
    //since spotify doesn't store when playlists were created, i had to make my own algorithm to try and deduce this
    //system flow: sort each playlist using the oldest added song as the discriminator, then take the first playlist,
    //which should be the oldest. I'm also sure to make sure the songs are in oldest descending order
    return Object.values(user_cache[uid].playlists).sort((a,b) => new Date(a.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at) - new Date(b.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at))[0];
}

const getLargestPlaylist = function (uid = '') {
    return Object.values(user_cache[uid].playlists).sort((a,b) => b.items.length - a.items.length)[0];
}

const convertDateToLongReadable = function (date = new Date()) {
    const dotm = date.getDate();
    let dotm_end;
    switch (dotm.toString().split('').pop()) {
        case 1:
            dotm_end = "st";
            break;
        case 2:
            dotm_end = "nd";
            break;
        case 3:
            dotm_end = "rd";
            break;
        default:
            dotm_end = "th";
    }
    return `${months[date.getMonth()]} ${dotm}${dotm_end}, ${date.getFullYear()}`;
}

const user_stats_cache = new Map();
const getUserStats = function(uid) {
    return user_stats_cache.has(uid) ?
        user_stats_cache.get(uid) :
        user_stats_cache.set(uid, {
            artists: {
                sorted: Object.values(user_cache[uid].artists).sort((a, b) => (b.occurrences - a.occurrences)),
                total: Object.values(user_cache[uid].artists).reduce((acc, obj) => acc + obj.occurrences, 0),
                unique: Object.values(user_cache[uid].artists).length,
                getDiversity() { return round((this.unique/this.total) * 100, 1) },
            },
            tracks: {
                sorted: Object.values(user_cache[uid].tracks).sort((a, b) => (b.occurrences - a.occurrences)),
                total: Object.values(user_cache[uid].tracks).reduce((acc, obj) => acc + obj.occurrences, 0),
                unique: Object.values(user_cache[uid].tracks).length,
            },
            playlists: {
                total: Object.values(user_cache[uid].playlists).length,
            },
        }).get(uid);
}

/**
 * Return the average distance between each number in the arrayy
 */
const averageDistance = function(nums = []) {
    const res = [];
    for (let i = 0, len = nums.length - 1, a = nums.shift(); i < len; i++, a = nums.shift())
        res.push(...nums.map(n => Math.abs(a - n)));
    return res.reduce((a, b) => a + b) / res.length;
}

//audio feature properties worth considering, by my discretion
const features = [
    'acousticness',
    'danceability',
    'energy',
    'valence',
];
const trackSimilarityRatio = function(tracks = []) {
    //for each track, take the average distance of each audio feature
    //then, take the one minus the average of all those avg distances 
    //to give songs with similar audio features a larger ratio
    return 1 - features
        .map(feature => averageDistance(tracks.map(track => track[feature])))
        .reduce((a, b) => a + b) / features.length;
}

const getIntersectingTracks = function (uids = []) {
    //look at all songs that appears in every user's profile
    //to filter those, find the ratio of occurences for that song compared to their entire library's size
    //then, find the average distance between each ratio.
    //I use average distance because I want songs with occurence levels are commonly agreed upon by all users, 
    //rather than songs that appear more often overall

    //array of songs that appear in all users profiles
    return _.intersection(...Object.values(user_cache).filter(({id}) => uids.includes(id)).map(({tracks}) => Object.keys(tracks)))
        .map(id => ({
            ...user_cache[uids[0]].tracks[id],
            // I know this copies over the occurrences property, but that's negligible for now
            avg_distance: averageDistance(Object.values(user_cache).filter(({id}) => uids.includes(id)).map(user => user.tracks[id].occurrences / getUserStats(user.id).tracks.total)),
        }))
        .sort((a, b) => a.avg_distance - b.avg_distance);   //smallest avg distances for closest taste proximity
}

/**
 * Fill in a track array with random songs that are likely to be enjoyed by all users in the `uid_array`
 */
const fillTracks = function({tracks = [], uids = [], target_size = 50}) {
    //what if there are no similar artists????
    similar_artists = _.intersection(...Object.values(user_cache).filter(({id}) => uids.includes(id)).map(({artists}) => Object.keys(artists)))
        .map(id => ({
            ...user_cache[uids[0]].artists[id],
            // I know this copies over the occurrences property, but that's negligible for now
            avg_distance: averageDistance(Object.values(user_cache).filter(({id}) => uids.includes(id)).map(user => user.artists[id].occurrences / getUserStats(user.id).artists.total)),
        }))
        .sort((a, b) => a.avg_distance - b.avg_distance);   //smallest avg distances for closest taste proximity
    //for every song needed, take the top intersecting artists between all users
    //for each user, take one song for each artist
    //to determine which song to pick from their library, sort each song by its
    //similarity to the song with the least avg distance from `tracks`
    //and pick the top song from those results, of course filtering for dups

    //first, determine how many tracks we will take per similar_artist.
    //this depends on how many more tracks we need and how many artists we have
    const tracks_per_artist_per_user = Math.ceil(((target_size - tracks.length) / similar_artists.length) / uids.length);

    for(const artist of similar_artists)
        for (const uid of uids) {
            if(tracks.length >= target_size) break;
            //get all songs by the artist
            const res = Object.values(user_cache[uid].tracks)
                .filter(({id}) => !tracks.some(t => t.id === id))   //filter out dups first
                .filter(({artists}) => artists.some(({id}) => id === artist.id))    //get tracks only by the current artist
                .map(track => ({
                    ...track,
                    track_similarity: trackSimilarityRatio([track, tracks.sort((a, b) => a.avg_distance - b.avg_distance)[0]]),
                })) //get track similarities
                .sort((a, b) => b.track_similarity - a.track_similarity)    //largest similiarity ratios at the front
                .slice(0, tracks_per_artist_per_user);  //limit array to be, at largest, the tracks that should be added for each user (see above formula)
            console.log(`artist: ${artist.name}, uid: ${uid}, res: `, res)
            !!res.length && tracks.push(...res);
        }
    
    //if array is still missing tracks, fill in the remaining ones
    // IMPLEMENT THIS
    return tracks.splice(0, target_size);    //truncate array just in case
}

const createPlaylist = function (params = { name: "Fusion Playlist" }) {
    //create a playlist with the given params, and return the created playlist
    return new Promise((resolve, reject) => {
        let url = "https://api.spotify.com/v1/users/" + spotify_credentials.uid + "/playlists";
        postSpotify(url, params).then(resolve)
            .catch(err => {
                console.log("err in createPlaylist... will attempt to recursively fix", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(createPlaylist(params)), 500); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(error => reject(error)); //this needs to be on the end of every nested promise
                else reject(err); //do something for handling errors and displaying it to the user
            });
    });
}

const prepTracksForPlaylistAddition = function (track_array) {
    //prepares an array of songs for addition to a spotify playlist
    //by sorting them into arrays of 100 songs each, then returning
    //an array that contains all of those 100-song arrays

    //shuffle the given array, then truncate it
    //let shuffledArray = shuffleArray(track_array);
    let tmparry = [];
    for (let i = 0, len = track_array.length; i < len; i++) { //for every element in track_array
        if (i % 100 == 0) {
            //console.log(i);
            //console.log(uri_array);
            tmparry.push([]); //if we've filled one subarray with 100 songs, create a new subarray
        }
        tmparry[tmparry.length - 1].push(track_array[i].uri); //go to the last subarray and add a song
        //repeat until we've gone thru every song in randomSongArray
    }
    if(tmparry.length > 10000) tmparry.length = 10000;    //truncate
    return tmparry;
}

const addTracksToPlaylist = function (playlist_obj, uri_array) {
    //uri_array needs to be less than 101, please make sure you've checked that before
    //you call this function, otherwise it will err

    //so... what about duplicates?
    return new Promise((resolve, reject) => {
        //let findDuplicates = arr => arr.filter((item, index) => arr.indexOf(item) != index);
        //var asd = findDuplicates(uri_array).length;
        //if(asd > 0) {
        //    console.log(asd +" duplicates found");
        //    reject({err:"duplicates!!!"});
        //}
        const url = "https://api.spotify.com/v1/users/" + playlist_obj.owner.id + "/playlists/" + playlist_obj.id + '/tracks';
        postSpotify(url, { uris: uri_array }).then(res => resolve({data:res, playlist_obj, uri_array}))  //resolve an obj for progressBar purposes
            .catch(err => {
                console.log(`error adding ${uri_array.length} tracks to playlist ${playlist_obj.name}.. attempting to fix recursively...`);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(addTracksToPlaylist(playlist_obj, uri_array)), 500); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(err => reject(err)); //this needs to be at the end of every nested promise
                else reject(err); //do something for handling errors and displaying it to the user
        });
    });
}

const addTracksToPlaylistHandler = function (playlist, uri_array) {
    let pending_addTracksToPlaylist_calls = []; //create a promise array
    console.log("starting API batch addTracksToPlaylist calls");
    return new Promise((resolve, reject) => {
        var uri_batch_index = 0,
            current_uri_batch,
            stagger_api_calls = setInterval(() => {
                current_uri_batch = uri_array[uri_batch_index];
                if (uri_batch_index >= uri_array.length) { //once we've reached the end of the uri_array
                    console.log("stopping API batch addTracksToPlaylist calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_addTracksToPlaylist_calls, (err, finished_api_calls) => {
                        console.log(err, finished_api_calls);
                        if (err) { // do something if i migrate this to its own function
                            console.log("error in API batch add function", finished_api_calls);
                            reject(finished_api_calls);
                        } //else would be redundant?
                        finished_api_calls.forEach(res => {
                            if (!res || !res.snapshot_id) { //if no snapshot... maybe change this to a customErrorKey or something?
                                console.log("no snapshot found, rejecting promise", res);
                                reject(finished_api_calls);
                            }
                        });
                        console.log("resolving addTracksToPlaylistHandler promise");
                        resolve("resolving from inside addTracksToPlaylistHandler");
                    });
                }
                //if we still have more tracks to add:
                console.log("calling api to addTracksToPlaylist uri_batch number " + uri_batch_index);
                pending_addTracksToPlaylist_calls.push(addTracksToPlaylist(playlist, current_uri_batch).then(resObj => {
                    //progressBarHandler({ current_operation:uri_array.findIndex(uri_batch => uri_batch == resObj.uri_array)+1, total_operations:uri_array.length, stage:5 });
                    return resObj.data;
                })); //no .catch() after addTracksToPlaylist b/c we want the error to appear in the callback, causing a reject to send to our main() function
                uri_batch_index++;
            }, 150);
    });
}

const loadHTML = function (uids) {
    $('#user-results-wrapper').html(`
        <details class="">
        <summary>There were <b>${getIntersectingTracks(uids).length}</b> songs in common</summary>
        
        <div class="tracks-block">
        ${(function () {
            let res = '';
            for(const track of getIntersectingTracks(uids))
                res += `
                    <div class="track-wrapper">
                        <div class="track">
                            <img src="${track.album?.images[0]?.url || './img/default_playlist_img.jpg'}" alt="Album art for '${track.album.name}'">
                            <p>
                                <span id="title">${track.name}</span><br>
                                by <span id="artist">${track.artists[0].name}</span>
                            </p>
                        </div>
                    </div>`;
            return res;
        })()}
        </div>
    </details>
    `);
}

const main = async function (uid_array = []) {
    console.log("Initializing main function...");
    CURRENTLY_RUNNING = true;
    try {
        //let new_session = database.ref('profilefusion/sessions').push();
        //new_session.set({
        //    sessionTimestamp:new Date().getTime(),
        //    sessionID:new_session.key,
        //    //sessionStatus:"pending",
        //    spotifyUID:spotify_credentials.uid,
        //    userAgent: navigator.userAgent,
        //    details: {
        //        target_users: uid_array,
        //    }
        //}, function (error) {
        //    if(error) console.log("Firebase error", error);
        //    else console.log("Firebase data written successfully");
        //});
        for (let i = 0; i < uid_array.length; i++) {
            pb = { min_val: i / uid_array.length, max_val: (i+1) / uid_array.length };
            await retrieveUserData(uid_array[i]);   //this updates user_cache
        }
        //so cache can be referenced from console
        document.user_cache = user_cache;

        
        progressBarHandler({stage: 'final'});
        let tracks = getIntersectingTracks(uid_array);
        console.log(tracks);
        tracks = tracks.length < 50 ?
            fillTracks({tracks, uids: uid_array}) : //modifies array in-place
            tracks.slice(0, 50);    //truncate
        console.log(tracks)
        //reset the html
        loadHTML(uid_array);
        //display the results
        $('#main-page').addClass('hidden');
        $('#results-page').removeClass('hidden');

        //time to add the songs to the playlist
        //first, create the playlist, storing the returned obj locally:
        //var is intentional so it can be used in catch block
        var playlist = await createPlaylist({
            name: 'Fusion Playlist',
            description: `A fusion between the Spotify libraries of ${new Intl.ListFormat('en').format(uid_array.map(uid => user_cache[uid].display_name))}`,
        });
        //prep songs for addition (make sure there aren't any extras and put them in subarrays of 100)
        let prepped_uri_array = prepTracksForPlaylistAddition(tracks);
        //add them to the playlist
        await addTracksToPlaylistHandler(playlist, prepped_uri_array);
    } catch (error) {
        progressBarHandler({stage: 'error'});  //change progressbar to red
        //"delete" the playlist we just created
        //playlists are never deleted on spotify. see this article: https://github.com/spotify/web-api/issues/555
        !!playlist?.id && await deleteSpotify(`https://api.spotify.com/v1/playlists/${playlist.id}/followers`)
            .then(() => console.log("playlist succesfully deleted"))
            .catch((err) => console.log(`unable to delete playlist, error: ${err}`));
        console.log(`ERROR: try-catch err: ${error}`);
        if(error.toString().includes('TypeError') || error.toString().includes('ReferenceError')) alert(`I ran into an error... screenshot this and send it to the developer:\n${error}`);
        return;
    } finally {
        CURRENTLY_RUNNING = false;
        console.log('execution finished');
    }
    progressBarHandler({stage: "done"});    //this is outside of the finally block to ensure it doesn't get executed if we trigger a return statement
}

$(document).ready(async function () {
    console.log(`Running ProfileFusion version ${CURRENT_VERSION}\nDeveloped by Elijah O`);
    firebase.initializeApp(credentials.firebase.config);
    database = firebase.database();
    performAuthDance();
});

$("#login-button").click(loginWithSpotify);

$('#main-button').click(function() {
    if(CURRENTLY_RUNNING) return alert('Program is already running!');

    for (const el of document.querySelectorAll('.user-link'))
        if(!checkInput(el.value)) return alert(`The input "${el.value}" is not valid`);

    //make sure at least two users have been added
    if(Array.from(document.querySelectorAll('.user-link'))
        .reduce((acc, cur) => 
            acc + (!!cur.value && checkInput(cur.value) ? 1 : 0), 0) < 2)
        return alert('You must specify at least two Spotify users!');
    $("#progress-bar-wrapper").removeClass("hidden"); //show progress bar
    progress_bar.set(0);    //reset progressbar
    //scroll to the bottom now that progressbar is visible
    //also add margin beneath it
    main(Array.from(document.querySelectorAll('.user-link')).map(el => getId(el.value)).filter(e => !!e));
});

$('#compare-more-button').click(function() {
    //redirect users to main compare page
    $('#results-page').addClass('hidden');
    $("#progress-bar-wrapper").addClass("hidden");
    $('#main-page').removeClass('hidden');
});

//adding a border to the details element
$("details").on("toggle", function () {
    if($(this).attr("open") != undefined) $(this).addClass("details-open");
    else $(this).removeClass("details-open");
});

const populateSearchInfo = function (user_object = {}, jQuery_element) {
    //populates the profile-info-wrapper with the given user information
    if(user_object.images.length > 0) $(jQuery_element).siblings('.profile-info-wrapper').children('img').attr('src', user_object.images[0].url);
    else $(jQuery_element).siblings('.profile-info-wrapper').children('img').attr('src', './img/default-pfp.jpg');
    $(jQuery_element).siblings('.profile-info-wrapper').children('p').text(user_object.display_name);
};

$(".user-link").on("input", function () {
    //update the profile of the user whenever the field is changed
    //if($(this).val() == current_input) return;  //prevent unnecessary api calls
    if($(this).val().trim() == '') return;    //prevent unnecessary api calls
    const current_input = $(this).val().trim();

    if(!checkInput(current_input)) {
        $(this).siblings('.profile-info-wrapper').children('img').attr('src', './img/x-img.png');
        $(this).siblings('.profile-info-wrapper').children('p').text('That is not a valid Spotify profile link');
    } else {
        if(!!user_cache[getId(current_input)] && user_cache[getId(current_input)].hasOwnProperty('display_name')) return populateSearchInfo(user_cache[getId(current_input)], this);
        callSpotify(`https://api.spotify.com/v1/users/${getId(current_input)}`).then((user) => {
            if(getId(user.external_urls.spotify) != getId($(this).val())) return;
            populateSearchInfo(user, this);
            user_cache[user.id] = {...user_cache[user.id], ...user}; //store the user in the cache - this minimizes api calls at the cost of increasing client memory
        }).catch((err) => {
            if(getId(err.url) != getId($(this).val())) return;
            $(this).siblings('.profile-info-wrapper').children('img').attr('src', './img/x-img.png');
            $(this).siblings('.profile-info-wrapper').children('p').text('That is not a valid Spotify profile link');
        });
    }
});