// Trimmed: only the geomprop lines of a generated pixel stage.
#version 300 es
precision mediump float;

in vec3 i_geomprop_rest;
in int i_geomprop_restoffset;
in float i_geomprop_streaks_horizontal;
in float i_geomprop_streaks_vertical;
    vec3 mtlxgeompropvalue_rest_out = i_geomprop_rest;
    int mtlxgeompropvalue_restoffset_out = i_geomprop_restoffset;
    float mtlxgeompropvalue_streaks_horizontal_out = i_geomprop_streaks_horizontal;
    float mtlxgeompropvalue_streaks_vertical_out = i_geomprop_streaks_vertical;
